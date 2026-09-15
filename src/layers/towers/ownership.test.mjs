import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createTowersLayer } from './index.js';
import { createTowerSource } from './source.js';
import { CAMERA_MOVE_DEBOUNCE_MS } from './index.js';

function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    camera: {
      computeViewRectangle() {
        return {
          north: (20.5 * Math.PI) / 180,
          south: (5.4 * Math.PI) / 180,
          east: (105.8 * Math.PI) / 180,
          west: (97.0 * Math.PI) / 180,
        };
      },
    },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createTowersLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}

const row = {
  radio: 'LTE',
  mcc: '310',
  mnc: '410',
  lac: '1001',
  cell: '2001',
  lat: 30.27,
  lon: -97.74,
  range: 1080,
  samples: 45,
  averageSignal: -78,
  operator: 'AT&T Mobility',
  brand: 'AT&T',
  networkTypes: 'LTE',
  frequencyBands: 'B2,B4',
  generations: '4g',
};

test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve({ ok: true, towers: [row] });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({
    getSnapshot: async () => ({ ok: true, towers: [row] }),
  });
  const b = harness({
    getSnapshot: async () => ({ ok: true, towers: [] }),
  });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});

test('body completion honors cancellation even with an uncooperative transport', async () => {
  const abort = new AbortController();
  const source = createTowerSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { ok: true, towers: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('a camera with no usable view rectangle must not fail the enable', async () => {
  let fetched = 0;
  const h = harness({
    getSnapshot: async () => {
      fetched += 1;
      return { ok: true, towers: [row] };
    },
  });
  h.viewer.camera = {
    computeViewRectangle() {
      return undefined;
    },
  };
  const result = await h.layer.update(h.viewer);
  assert.equal(result, true, 'edge-on/nadir camera keeps the enable alive');
  assert.equal(fetched, 0, 'no bbox means no tower fetch');
  assert.equal(h.layer.getStats().count, 0);
});

test('a settled camera fetches and renders towers', async () => {
  const h = harness({
    getSnapshot: async () => ({ ok: true, towers: [row] }),
  });
  h.viewer.camera = {
    computeViewRectangle() {
      return {
        north: (20.5 * Math.PI) / 180,
        south: (5.4 * Math.PI) / 180,
        east: (105.8 * Math.PI) / 180,
        west: (97.0 * Math.PI) / 180,
      };
    },
  };
  const result = await h.layer.update(h.viewer);
  assert.equal(result, true);
  assert.equal(h.layer.getStats().count, 1);
  const entity = h.sources[0].entities.values[0];
  assert.equal(
    entity.billboard.heightReference.getValue(Cesium.JulianDate.now()),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
});

test('far-side towers hide behind the planet and return with the camera', async () => {
  const nearRow = { ...row, lat: 13.7, lon: 100.5 };
  const farRow = {
    ...row,
    mnc: '999',
    lac: '9',
    cell: '9',
    lat: -13.7,
    lon: -79.5,
  };
  const changed = new Set();
  const sources = [];
  const camera = {
    computeViewRectangle() {
      return {
        north: (20.5 * Math.PI) / 180,
        south: (5.4 * Math.PI) / 180,
        east: (105.8 * Math.PI) / 180,
        west: (97.0 * Math.PI) / 180,
      };
    },
    positionWC: Cesium.Cartesian3.fromDegrees(100.5, 13.7, 20_000_000),
    changed: {
      addEventListener(fn) {
        changed.add(fn);
        return () => changed.delete(fn);
      },
    },
  };
  const viewer = {
    camera,
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createTowersLayer({
    source: {
      getSnapshot: async () => ({ ok: true, towers: [nearRow, farRow] }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(changed.size, 1, 'changed subscribed at init');
  await layer.update(viewer);
  const entities = sources[0].entities.values;
  assert.equal(entities.length, 2);
  const near = entities.find((e) => String(e.id).includes(':410:'));
  const far = entities.find((e) => String(e.id).includes(':999:'));
  assert.equal(near.show, true, 'near-side tower stays visible');
  assert.equal(far.show, false, 'far-side tower hides behind the planet');
  // Spin the globe to the far tower: visibility must flip mid-drag.
  camera.positionWC = Cesium.Cartesian3.fromDegrees(-79.5, -13.7, 20_000_000);
  for (const fn of [...changed]) fn();
  assert.equal(near.show, false, 'old continent hides after the spin');
  assert.equal(far.show, true, 'new continent shows after the spin');
  layer.disable(viewer);
  assert.equal(changed.size, 0, 'changed unsubscribed at disable');
  layer.destroy(viewer);
});

test('camera moveEnd re-fetches towers for the new viewport', async () => {
  let fetched = 0;
  const camera = {
    computeViewRectangle() {
      return {
        north: (20.5 * Math.PI) / 180,
        south: (5.4 * Math.PI) / 180,
        east: (105.8 * Math.PI) / 180,
        west: (97.0 * Math.PI) / 180,
      };
    },
    moveEnd: null,
  };
  const listeners = new Set();
  camera.moveEnd = {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const viewer = {
    camera,
    dataSources: { add() {}, remove() {} },
  };
  const layer = createTowersLayer({
    source: {
      getSnapshot: async () => {
        fetched += 1;
        return { ok: true, towers: [row] };
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(listeners.size, 1, 'moveEnd subscribed at init');
  for (const fn of [...listeners]) fn();
  await new Promise((r) => setTimeout(r, CAMERA_MOVE_DEBOUNCE_MS + 50));
  assert.equal(fetched, 1, 'camera settle triggers one debounced fetch');
  layer.disable(viewer);
  assert.equal(listeners.size, 0, 'moveEnd unsubscribed at disable');
});
