import assert from 'node:assert/strict';
import test from 'node:test';
import { createRailwaysLayer } from './index.js';
import { createRailwaySource } from './source.js';
function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createRailwaysLayer({
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
  stableId: 'train-1',
  number: '12951',
  name: 'MMCT RAJDHANI',
  type: 'rajdhani',
  lat: 22.97,
  lng: 72.6,
  currentStation: 'ADI',
  currentStationName: 'Ahmedabad Jn',
  nextStation: 'BRC',
  nextStationName: 'Vadodara Jn',
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
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});
test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => ({ ok: true, trains: [row] }) });
  const b = harness({ getSnapshot: async () => ({ ok: true, trains: [] }) });
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
  const source = createRailwaySource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { trains: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
