import * as Cesium from 'cesium';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import { fetchSpatialBuildings } from '../sources/spatialBuildings.js';
import {
  BUILDING_LIMIT,
  LOAD_RADIUS_M,
  USE_COLORS,
  parseBuildings,
  containsPoint,
  validRing,
  selfIntersects,
  selectBuildings,
  buildingFacts,
  distanceM,
  spatialQuestionKind,
} from './buildings.js';
import { createBuildingRenderer } from './renderer.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const number = (n) =>
  new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(n);

/** A bounded spatial workspace. Owns its listeners, pointer lease, requests and render data. */
export function initSpatialWorkspace({ viewer }) {
  if (!viewer) return null;
  const root = el('section', 'spatial-workspace');
  root.id = 'spatial-workspace';
  root.setAttribute('aria-label', 'Spatial conversation');
  root.innerHTML = `<button class="spatial-launch" aria-expanded="false"><span class="spatial-orb" aria-hidden="true"></span>Ask the world <span class="spatial-key">3D</span></button>
    <div class="spatial-panel" hidden>
      <header><div><div class="spatial-eyebrow">GOD’S EYE VIEW / SPATIAL</div><h2>Make the world your context.</h2></div><button class="spatial-close" aria-label="Close spatial workspace">×</button></header>
      <div class="spatial-body">
        <p class="spatial-intro">Point to a building. Shift-click to compare. Draw around a block.</p>
        <div class="spatial-toolbar"><button data-action="load" class="spatial-primary">Load buildings here</button><button data-action="draw">Draw area</button><button data-action="all">Select loaded</button></div>
        <div class="spatial-draw-tools" hidden><span>Drag an outline or click corners.</span><button data-action="finish">Finish</button><button data-action="cancel">Cancel</button></div>
        <p class="spatial-status" role="status" aria-live="polite">Explore a neighborhood, then load its buildings.</p>
        <div class="spatial-scope"><span class="spatial-orb" aria-hidden="true"></span><div><strong class="spatial-scope-name">No selection yet</strong><span class="spatial-scope-detail">Your question will stay attached to this place.</span></div><button data-action="clear" aria-label="Clear selection">×</button></div>
        <label class="spatial-rule" hidden>Include buildings <select aria-label="Building selection rule"><option value="intersects">touching the outline</option><option value="inside">fully inside the outline</option></select></label>
        <div class="spatial-suggestions"><button data-question="overview">What’s here?</button><button data-question="use">Color by use</button><button data-question="height">Which is tallest?</button></div>
        <form class="spatial-question"><label class="spatial-sr" for="spatial-question-input">Ask about your selection</label><textarea id="spatial-question-input" rows="2" maxlength="1200" placeholder="Ask about this building or area…"></textarea><button type="submit" aria-label="Ask about selection">↑</button></form>
        <div class="spatial-answer" aria-live="polite" aria-label="Spatial answer" hidden><div class="spatial-answer-meta"></div><p class="spatial-answer-text"></p><button data-action="refresh" hidden>Refresh for this selection</button></div>
        <div class="spatial-legend" hidden></div>
        <p class="spatial-height-key" hidden><i aria-hidden="true"></i>Hatched volumes have estimated display heights.</p>
        <details class="spatial-evidence"><summary>Inspect evidence <span class="spatial-evidence-count">0</span></summary><div class="spatial-metrics"></div><div class="spatial-evidence-list"></div><p class="spatial-evidence-limit"></p></details>
        <p class="spatial-coverage">OpenStreetMap geometry and tags. Unrecorded heights are estimates for display only.</p>
      </div>
    </div>`;
  document.body.append(root);
  const q = (selector) => root.querySelector(selector);
  const renderer = createBuildingRenderer(viewer, {
    onModeChange: () => {
      q('.spatial-coverage').textContent = coverage();
    },
  });
  let open = false,
    destroyed = false,
    lease = null,
    records = [],
    selected = [],
    loadInfo = null,
    center = null;
  let ring = null,
    drawing = false,
    vertices = [],
    dragging = false,
    moved = false,
    startPixel = null,
    oldCameraInputs = null;
  let revision = 0,
    answerRevision = -1,
    requestSequence = 0,
    requestController = null,
    loadController = null;
  let categorized = false,
    focused = null,
    hover = null,
    lastHover = 0,
    lastDraw = 0,
    lastQuestion = null;
  let savedClick, savedDoubleClick;
  const metrics = { loads: [], selections: [], queries: [] };
  const listeners = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };
  const status = (text) => {
    q('.spatial-status').textContent = text;
  };
  const selection = () => {
    const ids = new Set(selected);
    return records.filter((r) => ids.has(r.id));
  };
  const facts = () => buildingFacts(selection(), center);
  const paint = () =>
    renderer.style({ ids: selected, categorized, focus: focused, hover });
  function coverage() {
    if (!loadInfo)
      return 'OpenStreetMap geometry and tags. Unrecorded heights are estimates for display only.';
    return `${number(records.length)} building footprints loaded within ${LOAD_RADIUS_M} m of the search center. OSM ways only; complex relation buildings may be missing. ${loadInfo.truncated ? `Capped at ${BUILDING_LIMIT}; results are partial. ` : ''}${loadInfo.incomplete ? 'Source returned a partial response. ' : ''}${loadInfo.skipped ? `${loadInfo.skipped} records had unusable geometry. ` : ''}${renderer.mode}. Heights may be display estimates. OSM snapshot: ${loadInfo.timestamp || 'not supplied'}.`;
  }
  function evidence() {
    const f = facts();
    q('.spatial-evidence-count').textContent = number(f.count);
    q('.spatial-metrics').textContent =
      `${number(f.footprintM2)} m² mapped footprint · ${f.knownHeights}/${f.count} recorded heights`;
    const list = q('.spatial-evidence-list');
    list.replaceChildren();
    for (const r of selection().slice(0, 60)) {
      const row = el('div', 'spatial-evidence-row');
      const focus = el('button', '', r.name);
      focus.title = 'Focus this building';
      focus.dataset.focus = r.id;
      const detail = el(
        'small',
        '',
        `${r.use} · ${r.heightM === null ? 'Height unrecorded' : `${number(r.heightM)} m recorded`} · ${number(r.footprintM2)} m²`,
      );
      const link = el('a', '', 'OSM ↗');
      link.href = `https://www.openstreetmap.org/${r.osmType}/${r.osmId}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open source for ${r.name}`);
      row.append(focus, detail, link);
      list.append(row);
    }
    q('.spatial-evidence-limit').textContent =
      f.count > 60
        ? `Showing 60 of ${number(f.count)} selected records. Summaries use every selected record.`
        : 'Footprint areas are calculated from mapped geometry. Categories follow recorded building tags.';
    q('.spatial-coverage').textContent = coverage();
  }
  function updateScope(label) {
    revision++;
    requestSequence++;
    requestController?.abort();
    focused = null;
    q('.spatial-scope-name').textContent = label;
    q('.spatial-scope-detail').textContent = selected.length
      ? `${number(selected.length)} building${selected.length === 1 ? '' : 's'} selected · OSM evidence`
      : 'Select a loaded building or draw an area.';
    q('.spatial-rule').hidden = !ring;
    if (answerRevision >= 0 && answerRevision !== revision) {
      q('.spatial-answer-meta').textContent =
        'Selection changed · previous answer';
      q('.spatial-answer').classList.add('is-stale');
      q('[data-action="refresh"]').hidden = false;
    }
    if (categorized && selected.length) showLegend(facts());
    else q('.spatial-legend').hidden = true;
    q('.spatial-question button').disabled = false;
    paint();
    evidence();
  }
  function setSelection(ids, label) {
    const t = performance.now();
    selected = ids;
    updateScope(label);
    metrics.selections.push(performance.now() - t);
    metrics.selections = metrics.selections.slice(-100);
  }
  function world(pixel) {
    const p = pickWorldFromScreen(
      viewer,
      pixel.x / viewer.canvas.clientWidth,
      pixel.y / viewer.canvas.clientHeight,
    );
    return p && Number.isFinite(p.lon) && Number.isFinite(p.lat)
      ? [p.lon, p.lat]
      : null;
  }
  function setOpen(value) {
    if (value === open) return;
    if (value) {
      lease = claimPointer('spatial');
      if (!lease) {
        q('.spatial-launch').title = 'Finish the active drawing tool first.';
        q('.spatial-launch').setAttribute(
          'aria-label',
          'Finish the active drawing tool before opening spatial questions',
        );
        return;
      }
      q('.spatial-launch').removeAttribute('aria-label');
      q('.spatial-launch').title = '';
      savedClick = viewer.screenSpaceEventHandler.getInputAction(
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      savedDoubleClick = viewer.screenSpaceEventHandler.getInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
      viewer.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      viewer.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    } else {
      stopDrawing();
      requestSequence++;
      requestController?.abort();
      loadController?.abort();
      releasePointer(lease);
      lease = null;
      if (savedClick)
        viewer.screenSpaceEventHandler.setInputAction(
          savedClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      if (savedDoubleClick)
        viewer.screenSpaceEventHandler.setInputAction(
          savedDoubleClick,
          Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );
    }
    open = value;
    q('.spatial-panel').hidden = !value;
    q('.spatial-launch').setAttribute('aria-expanded', String(value));
    renderer.setVisible(value);
    root.classList.toggle('is-open', value);
  }
  async function load() {
    if (!open) return;
    const here = world({
      x: viewer.canvas.clientWidth / 2,
      y: viewer.canvas.clientHeight / 2,
    });
    if (!here) {
      status('Point the camera at the ground to load a neighborhood.');
      return;
    }
    stopDrawing();
    loadController?.abort();
    loadController = new AbortController();
    const controller = loadController,
      started = performance.now();
    q('[data-action="load"]').disabled = true;
    status('Reading nearby building footprints…');
    try {
      const timeout = setTimeout(() => controller.abort(), 35000);
      let payload;
      try {
        payload = await fetchSpatialBuildings(here, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (
        destroyed ||
        controller !== loadController ||
        controller.signal.aborted
      )
        return;
      const parsed = parseBuildings(payload);
      stopDrawing();
      records = parsed.records;
      categorized = false;
      q('.spatial-height-key').hidden = !records.length;
      loadInfo = parsed;
      center = here;
      ring = null;
      hover = null;
      renderer.replace(records);
      setSelection([], 'Choose your context');
      metrics.loads.push({
        durationMs: performance.now() - started,
        count: records.length,
      });
      status(
        records.length
          ? `${number(records.length)} buildings ready. Click one, or draw around a block.`
          : 'No mapped buildings were returned here. Move to another neighborhood.',
      );
    } catch (error) {
      if (!destroyed && controller === loadController && open)
        status(
          controller.signal.aborted
            ? 'Building request timed out. Your previous selection is still available.'
            : error.message,
        );
    } finally {
      if (!destroyed && controller === loadController)
        q('[data-action="load"]').disabled = false;
    }
  }
  function stopDrawing() {
    if (drawing && oldCameraInputs !== null)
      viewer.scene.screenSpaceCameraController.enableInputs = oldCameraInputs;
    drawing = false;
    root.classList.remove('is-drawing');
    dragging = false;
    oldCameraInputs = null;
    vertices = [];
    q('.spatial-draw-tools').hidden = true;
    q('[data-action="draw"]').classList.remove('is-active');
    viewer.canvas.style.cursor = '';
    renderer.setArea(ring);
  }
  function startDrawing() {
    if (!open || !records.length) {
      status('Load buildings before drawing an area.');
      return;
    }
    stopDrawing();
    drawing = true;
    root.classList.add('is-drawing');
    oldCameraInputs = viewer.scene.screenSpaceCameraController.enableInputs;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    q('.spatial-draw-tools').hidden = false;
    q('[data-action="draw"]').classList.add('is-active');
    viewer.canvas.style.cursor = 'crosshair';
    status(
      window.matchMedia('(max-width: 520px), (pointer: coarse)').matches
        ? 'Drag an outline, or tap corners and choose Finish. Cancel keeps your previous selection.'
        : 'Drag around buildings, or click corners and press Enter. Escape cancels.',
    );
  }
  function finishDrawing() {
    const next = validRing(vertices);
    if (!next || selfIntersects(next)) {
      stopDrawing();
      status(
        'That outline crossed itself or was too small. Your previous selection is retained; choose Draw area to retry.',
      );
      return;
    }
    if (next.some((p) => distanceM(center, p) > LOAD_RADIUS_M * 2)) {
      stopDrawing();
      status(
        'Keep the outline near the loaded buildings, or load the new neighborhood.',
      );
      return;
    }
    ring = next;
    stopDrawing();
    const subset = selectBuildings(
      records,
      ring,
      q('.spatial-rule select').value,
    );
    setSelection(
      subset.map((r) => r.id),
      'Your drawn area',
    );
    status(
      `${number(subset.length)} loaded buildings ${q('.spatial-rule select').value === 'inside' ? 'fully inside' : 'touch'} this outline. Coverage is limited to the loaded neighborhood.`,
    );
  }
  function showAnswer(text, label, seq) {
    if (destroyed || seq !== requestSequence) return false;
    answerRevision = revision;
    q('.spatial-answer').hidden = false;
    q('.spatial-answer').classList.remove('is-stale');
    q('.spatial-answer-meta').textContent = label;
    q('.spatial-answer-text').textContent = text;
    q('[data-action="refresh"]').hidden = true;
    requestAnimationFrame(() => {
      if (!destroyed && open && seq === requestSequence)
        q('.spatial-answer').scrollIntoView({ block: 'nearest' });
    });
    return true;
  }
  function showLegend(f) {
    const legend = q('.spatial-legend');
    legend.replaceChildren();
    for (const [use, n] of Object.entries(f.categories))
      if (n) {
        const item = el('span', '', `${use} ${n}`);
        const dot = el('i');
        dot.style.background = USE_COLORS[use];
        item.prepend(dot);
        legend.append(item);
      }
    legend.hidden = false;
  }
  async function ask(question, kind = null) {
    if (!selected.length) {
      status('Select at least one building first.');
      return { ok: false, error: 'No building selection.' };
    }
    requestController?.abort();
    kind ||= spatialQuestionKind(question);
    requestController = new AbortController();
    const controller = requestController,
      seq = ++requestSequence,
      started = performance.now(),
      f = facts();
    lastQuestion = { question, kind };
    focused = null;
    const label = 'Calculated from your selection';
    if (kind === 'overview')
      showAnswer(
        `${number(f.count)} mapped building${f.count === 1 ? '' : 's'}, covering ${number(f.footprintM2)} m² of footprint. ${f.knownHeights} have recorded heights; ${f.unknownHeights} do not. ${f.categories.unknown} have no recognized building-use category.`,
        label,
        seq,
      );
    else if (kind === 'use') {
      categorized = true;
      showLegend(f);
      paint();
      showAnswer(
        Object.entries(f.categories)
          .filter(([, n]) => n)
          .map(([use, n]) => `${n} ${use}`)
          .join(' · ') +
          '. Colors follow recorded OSM tags; unknown stays unknown.',
        label,
        seq,
      );
    } else if (kind === 'height') {
      focused = f.tallest?.id || null;
      paint();
      showAnswer(
        f.tallest
          ? `${f.unknownHeights ? 'Actual tallest is inconclusive. ' : ''}${f.tallest.name} has the greatest recorded height in this selection: ${number(f.tallest.heightM)} m. ${f.unknownHeights} height${f.unknownHeights === 1 ? ' is' : 's are'} unrecorded.`
          : 'None of these buildings has a recorded height. The 3D display uses estimates; those cannot establish which building is tallest.',
        label,
        seq,
      );
    } else if (kind === 'distance') {
      const pair = selection();
      showAnswer(
        f.pair
          ? `${pair[0].name} and ${pair[1].name} are approximately ${number(f.pair.distanceM)} m apart, measured horizontally between footprint bounding-box centers. This is not a walking distance or a gap between walls.`
          : 'Select two buildings to compare their distance. Click one, then Shift-click the other, or draw around a pair.',
        label,
        seq,
      );
    } else {
      q('.spatial-question button').disabled = true;
      status('Reasoning over the selected building evidence…');
      try {
        const timeout = setTimeout(() => controller.abort(), 45000);
        let response;
        try {
          response = await fetch('/api/openai/spatial-answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              question,
              facts: f,
              scope: {
                label: q('.spatial-scope-name').textContent,
                revision,
                coverage: coverage(),
                rule: ring
                  ? q('.spatial-rule select').value
                  : 'explicit building selection',
              },
            }),
          });
        } finally {
          clearTimeout(timeout);
        }
        const data = await response.json();
        if (!response.ok || !data.answer)
          throw new Error(
            data.error ||
              'The assistant could not answer. Calculated questions still work.',
          );
        if (
          showAnswer(data.answer, 'AI explanation · supplied OSM evidence', seq)
        )
          status(
            'Answer attached to this selection. Inspect the source records below.',
          );
      } catch (error) {
        if (seq === requestSequence && !destroyed)
          status(
            controller.signal.aborted
              ? 'The answer timed out. Your selection and evidence are preserved.'
              : error.message,
          );
      } finally {
        if (seq === requestSequence && !destroyed)
          q('.spatial-question button').disabled = false;
      }
    }
    metrics.queries.push({
      durationMs: performance.now() - started,
      kind: kind || 'model',
      count: f.count,
    });
    metrics.queries = metrics.queries.slice(-100);
    return { ok: seq === requestSequence, facts: f, scopeRevision: revision };
  }

  listen(q('.spatial-launch'), 'click', () => setOpen(!open));
  listen(q('.spatial-close'), 'click', () => {
    if (!open) q('.spatial-panel').hidden = true;
    else setOpen(false);
  });
  listen(root, 'click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'load') load();
    if (action === 'draw') startDrawing();
    if (action === 'finish') finishDrawing();
    if (action === 'cancel') {
      stopDrawing();
      status('Drawing cancelled. Previous selection retained.');
    }
    if (action === 'clear') {
      ring = null;
      stopDrawing();
      setSelection([], 'No selection');
    }
    if (action === 'all') {
      ring = null;
      stopDrawing();
      setSelection(
        records.map((r) => r.id),
        'Loaded neighborhood',
      );
    }
    if (action === 'refresh' && lastQuestion)
      ask(lastQuestion.question, lastQuestion.kind);
    if (button.dataset.question)
      ask(button.textContent, button.dataset.question);
    if (button.dataset.focus) {
      focused = button.dataset.focus;
      paint();
      renderer.focus(records.find((r) => r.id === focused));
    }
  });
  listen(q('.spatial-rule select'), 'change', () => {
    if (ring)
      setSelection(
        selectBuildings(records, ring, q('.spatial-rule select').value).map(
          (r) => r.id,
        ),
        'Your drawn area',
      );
  });
  listen(q('form'), 'submit', (event) => {
    event.preventDefault();
    const text = q('textarea').value.trim();
    if (text) ask(text);
  });
  listen(q('textarea'), 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      q('form').requestSubmit();
    }
  });
  listen(window, 'keydown', (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      if (drawing) stopDrawing();
      else {
        setOpen(false);
        q('.spatial-launch').focus();
      }
      return;
    }
    if (
      !open ||
      event.target.closest?.(
        'input,textarea,select,button,a,[contenteditable="true"]',
      )
    )
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (drawing) stopDrawing();
      else setOpen(false);
    }
    if (event.key === 'Enter' && drawing) {
      event.preventDefault();
      finishDrawing();
    }
    if (event.key === 'Backspace' && drawing) {
      event.preventDefault();
      vertices.pop();
      renderer.setArea(vertices.length > 1 ? vertices : null);
    }
  });
  const pixel = (e) => {
    const b = viewer.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  listen(viewer.canvas, 'pointerdown', (e) => {
    if (!open || !drawing || e.button !== 0) return;
    dragging = true;
    moved = false;
    startPixel = pixel(e);
    viewer.canvas.setPointerCapture(e.pointerId);
    const p = world(startPixel);
    if (p) vertices.push(p);
    renderer.setArea(vertices.length > 1 ? vertices : null);
  });
  listen(viewer.canvas, 'pointermove', (e) => {
    if (!open || !drawing || !dragging || performance.now() - lastDraw < 32)
      return;
    const at = pixel(e);
    if (Math.hypot(at.x - startPixel.x, at.y - startPixel.y) < 8) return;
    lastDraw = performance.now();
    moved = true;
    startPixel = at;
    const p = world(at);
    if (p && vertices.length < 128) vertices.push(p);
    renderer.setArea(vertices.length > 1 ? vertices : null);
  });
  listen(viewer.canvas, 'pointerup', () => {
    if (!drawing || !dragging) return;
    dragging = false;
    if (moved && vertices.length >= 3) finishDrawing();
  });
  listen(viewer.canvas, 'pointercancel', () => {
    if (drawing) stopDrawing();
  });
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  function buildingAt(position) {
    const picked = viewer.scene.pick(position);
    if (picked?.id?.__gevBuildingId) return picked.id.__gevBuildingId;
    const p = world(position);
    if (!p) return null;
    return (
      records.find(
        (r) =>
          p[0] >= r.bounds[0] &&
          p[0] <= r.bounds[2] &&
          p[1] >= r.bounds[1] &&
          p[1] <= r.bounds[3] &&
          r.polygons.some(
            (poly) =>
              containsPoint(poly.outer, p) &&
              !poly.holes.some((h) => containsPoint(h, p)),
          ),
      )?.id || null
    );
  }
  function clickBuilding(event, additive = false) {
    if (!open || drawing || moved) {
      moved = false;
      return;
    }
    const id = buildingAt(event.position);
    if (!id) return;
    ring = null;
    renderer.setArea(null);
    const ids = additive
      ? selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id]
      : [id];
    setSelection(
      ids,
      ids.length === 1
        ? records.find((r) => r.id === ids[0]).name
        : 'Your building comparison',
    );
    status(
      ids.length === 2
        ? 'Two buildings selected. Ask “How far apart are these?”'
        : 'Building selected. Shift-click another to compare, or ask a question.',
    );
  }
  handler.setInputAction(clickBuilding, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(
    (event) => clickBuilding(event, true),
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
    Cesium.KeyboardEventModifier.SHIFT,
  );
  handler.setInputAction((event) => {
    if (
      !open ||
      drawing ||
      !records.length ||
      performance.now() - lastHover < 80
    )
      return;
    lastHover = performance.now();
    const id = buildingAt(event.endPosition);
    if (id !== hover) {
      hover = id;
      viewer.canvas.style.cursor = id ? 'pointer' : '';
      paint();
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  const api = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    getContext: () => ({
      active: open,
      revision,
      scope: q('.spatial-scope-name').textContent,
      coverage: coverage(),
      ...facts(),
    }),
    query: async ({ question = 'What is here?', kind = 'overview' } = {}) => {
      if (!open) setOpen(true);
      if (!open)
        return {
          ok: false,
          error:
            'Finish the active drawing tool before querying the spatial selection.',
        };
      return ask(
        question,
        ['overview', 'use', 'height', 'distance'].includes(kind) ? kind : null,
      );
    },
    diagnostics: () => ({
      open,
      drawing,
      revision,
      answerRevision,
      loaded: records.length,
      selected: selected.length,
      mode: renderer.mode,
      metrics: structuredClone(metrics),
    }),
    destroy() {
      if (destroyed) return;
      setOpen(false);
      destroyed = true;
      loadController?.abort();
      requestController?.abort();
      handler.destroy();
      listeners.forEach(([t, type, fn, opts]) =>
        t.removeEventListener(type, fn, opts),
      );
      renderer.destroy();
      root.remove();
    },
  };
  return api;
}
