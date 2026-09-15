import * as Cesium from 'cesium';
import { trainIcon } from '../../data/trainIcons.js';
import {
  RAILWAY_OVERLAY_SOURCE_ID,
  RAILWAY_OVERLAY_COHORT_LIMIT,
  RAILWAY_OVERLAY_COLLISION_CAPACITY,
  railwayClass,
  railwayColor,
  createRailwayOverlayEntry,
  buildSelectedTrainCard,
  selectRailwayOverlayCohort,
  normalizeRailwayRow,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createRailwaySource } from './source.js';

const DEFAULT_UPDATE_MS = 10 * 60_000;
/** Sandbox accounting lives in DATA_SOURCES.md; tighten via .env if you poll harder. */
function updateIntervalMs() {
  const configured = Number(import.meta.env?.VITE_RAILWAYS_UPDATE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_UPDATE_MS;
}

/** Own one live Indian Railways display and its refresh lifecycle. */
export function createRailwaysLayer({
  source,
  overlayHost,
  services = {},
  screenSpaceEventHandlerFactory,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Railways require a snapshot source');
  if (!overlayHost) throw new TypeError('Railways require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _keyRequired = false;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedTrain = null;
  const _pickIndexById = new Map();
  let _ambientEntries = [];

  const layer = {
    id: 'railways',
    name: 'Indian Railways (Live)',
    icon: '🚆',
    source: 'RailRadar · LIVE',
    updateInterval: updateIntervalMs(),

    init(viewer) {
      if (_viewer) throw new Error('Railways layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('railways');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      _enabled = false;
      overlayHost.setVisible(RAILWAY_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Railways] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(RAILWAY_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(RAILWAY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RAILWAY_OVERLAY_SOURCE_ID, false);
      _ambientEntries = [];
      _removeClickHandler();
      _clearSelection();
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        if (snapshot?.keyRequired) {
          _keyRequired = true;
          _dataSource.entities.removeAll();
          overlayHost.clearSource(RAILWAY_OVERLAY_SOURCE_ID);
          _count = 0;
          _lastUpdate = null;
          _lastError = 'KEY REQUIRED';
          return true;
        }
        _keyRequired = false;

        const rows = [];
        for (const [index, raw] of (snapshot?.trains ?? []).entries()) {
          const row = normalizeRailwayRow(raw, index);
          if (row) rows.push(row);
        }

        const nextEntities = [];
        const overlayEntries = [];
        const nextPickIndex = new Map();

        for (const row of rows) {
          const cls = railwayClass(row.type);
          const color = railwayColor(cls);
          const position = Cesium.Cartesian3.fromDegrees(row.lng, row.lat);
          const entityId = `railway:${row.stableId}`;
          nextEntities.push(
            new Cesium.Entity({
              id: entityId,
              position,
              billboard: {
                image: trainIcon(),
                width: 20,
                height: 20,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                color,
              },
              properties: {
                railwayRow: row,
                railwayClass: cls,
                railwayTrainId: row.stableId,
              },
            }),
          );
          nextPickIndex.set(entityId, {
            id: entityId,
            stableId: row.stableId,
            number: row.number,
            name: row.name,
            type: row.type,
            railwayClass: cls,
            lat: row.lat,
            lng: row.lng,
            currentStation: row.currentStation,
            currentStationName: row.currentStationName,
            nextStation: row.nextStation,
            nextStationName: row.nextStationName,
          });
          overlayEntries.push(
            createRailwayOverlayEntry({
              id: row.stableId,
              position,
              number: row.number,
              trainClass: cls,
            }),
          );
        }

        _pickIndexById.clear();
        for (const [k, v] of nextPickIndex) _pickIndexById.set(k, v);

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _ambientEntries = overlayEntries;
        if (_enabled) {
          _rebuildOverlayEntries();
        }

        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Railways] Updated: ${_count} trains`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Railways] Fetch error:', e);
        _lastError = e?.message || 'Train source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      _keyRequired = false;
      overlayHost.clearSource(RAILWAY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RAILWAY_OVERLAY_SOURCE_ID, false);
      _ambientEntries = [];
      _removeClickHandler();
      _clearSelection();
      _pickIndexById.clear();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory train records as plain JSON-safe objects
     * for the analyst query engine. On-demand only (called at most once per
     * spoken query) — zero per-frame cost. Returns [] while disabled/empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              number: p?.number?.getValue(now),
              name: p?.name?.getValue(now),
              type: p?.type?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
              currentStation: p?.currentStation?.getValue(now),
              currentStationName: p?.currentStationName?.getValue(now),
              nextStation: p?.nextStation?.getValue(now),
              nextStationName: p?.nextStationName?.getValue(now),
            },
            result.length,
          ),
        );
      }
      return result;
    },

    /**
     * Return a subset of trains for the universal detection overlay.
     * Deterministic stride sampling distributes selections evenly across the
     * current record list while honoring the overlay's per-layer budget.
     */
    getDetectableObjects({ maxCount } = {}) {
      if (!_enabled || !_dataSource?.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2600;
      const stride = Math.max(1, Math.ceil(entities.length / limit));
      const now = Cesium.JulianDate.now();
      const result = [];
      for (let index = 0; index < entities.length; index += stride) {
        const entity = entities[index];
        const position = entity.position?.getValue(now);
        if (!position) continue;
        const p = entity.properties;
        const number = p?.number?.getValue(now) ?? entity.id;
        result.push({
          position,
          sourceId: String(number),
          id: String(number),
          type: 'VEH',
          metric: String(p?.name?.getValue(now) ?? ''),
        });
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _keyRequired ? 'KEY REQUIRED' : _lastError,
        keyRequired: _keyRequired,
      };
    },
  };
  // ── click selection ──────────────────────────────────────────────────

  const { resolvePickId, isOwnedByOtherLayer } = services.picking ?? {};
  const {
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    registerEntityContext,
  } = services.context ?? {};

  function _installClickHandler(viewer) {
    if (_clickHandler || !viewer) return;
    if (!screenSpaceEventHandlerFactory) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const train = _pickedTrain(picked);
      if (train) {
        _selectTrain(train);
        return;
      }
      if (picked) {
        const pickedId = resolvePickId?.(picked);
        if (pickedId && isOwnedByOtherLayer?.('railways', pickedId)) return;
      }
      _clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function _removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function _pickedTrain(picked) {
    if (!picked) return null;
    const ids = [
      resolvePickId?.(picked),
      typeof picked.primitive?.id === 'string' ? picked.primitive?.id : null,
      typeof picked.id === 'string' ? picked.id : null,
    ];
    for (const id of ids) {
      if (typeof id === 'string' && _pickIndexById.has(id))
        return _pickIndexById.get(id);
    }
    return null;
  }

  function _rebuildOverlayEntries() {
    if (!_enabled) return;
    const entries = [..._ambientEntries];
    if (_selectedTrain) {
      entries.push(
        buildSelectedTrainCard(
          _selectedTrain,
          Cesium.Cartesian3.fromDegrees(_selectedTrain.lng, _selectedTrain.lat),
        ),
      );
    }
    overlayHost.setEntries(
      RAILWAY_OVERLAY_SOURCE_ID,
      selectRailwayOverlayCohort(entries),
      {
        cohortLimit: RAILWAY_OVERLAY_COHORT_LIMIT,
        collisionCapacity: RAILWAY_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  function _selectTrain(train) {
    _selectedTrain = train;
    _rebuildOverlayEntries();
    if (!registerEntityContext) return;
    const recordId = `railway:${train.stableId}`;
    try {
      const carrier = { show: true };
      registerEntityContext(carrier, {
        id: recordId,
        layerId: 'railways',
        layerName: 'Indian Railways',
        source: 'RailRadar',
        dataSource: _dataSource,
        label: `${train.name ?? train.number} · ${train.type ?? 'Train'}`,
        latitude: train.lat,
        longitude: train.lng,
        properties: {
          trainNumber: train.number,
          trainName: train.name,
          trainType: train.type,
          currentStation: train.currentStationName || train.currentStation,
          nextStation: train.nextStationName || train.nextStation,
        },
      });
      selectEntityContext?.(carrier);
    } catch {
      /* context store unavailable */
    }
  }

  function _clearSelection() {
    if (!_selectedTrain) return;
    _selectedTrain = null;
    _rebuildOverlayEntries();
    try {
      clearSelectedEntityContextForLayer?.('railways');
    } catch {
      /* context store unavailable */
    }
  }

  return layer;
}
