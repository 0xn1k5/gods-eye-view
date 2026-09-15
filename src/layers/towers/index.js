import * as Cesium from 'cesium';
import { towerIcon } from '../../data/towerIcon.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import {
  TOWER_OVERLAY_SOURCE_ID,
  TOWER_OVERLAY_COHORT_LIMIT,
  TOWER_OVERLAY_COLLISION_CAPACITY,
  towerClass,
  towerColor,
  createTowerOverlayEntry,
  buildSelectedTowerCard,
  selectTowerOverlayCohort,
  normalizeTowerRow,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createTowerSource, towerBoundsQuery } from './source.js';

const DEFAULT_UPDATE_MS = 15 * 60_000;
/** OpenCelliD is a static CSV re-read into an in-memory index on the server;
 * the window only homes in changes. Tighten via .env if you refresh harder. */
function updateIntervalMs() {
  const configured = Number(import.meta.env?.VITE_TOWERS_UPDATE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_UPDATE_MS;
}

/** Debounce before fetching after a camera settles, so flights/pans issue one
 * homes-in request instead of a burst per move (installations-style contract). */
export const CAMERA_MOVE_DEBOUNCE_MS = 400;

/** Own one live cell-tower display and its refresh lifecycle. */
export function createTowersLayer({
  source,
  overlayHost,
  services = {},
  screenSpaceEventHandlerFactory,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Towers require a snapshot source');
  if (!overlayHost) throw new TypeError('Towers require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _dataAvailable = true;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedTower = null;
  let _cameraMoveEndRemover = null;
  let _cameraMoveTimer = null;
  let _cameraChangedRemover = null;
  const _cullScratch = new Cesium.Cartesian3();
  const _pickIndexById = new Map();
  let _ambientEntries = [];

  const layer = {
    id: 'towers',
    name: 'Cell Towers',
    icon: '📶',
    source: 'OpenCelliD · mcc-mnc',
    updateInterval: updateIntervalMs(),

    init(viewer) {
      if (_viewer) throw new Error('Towers layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('towers');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _dataAvailable = true;
      _enabled = false;
      _installCameraMoveRefresh(viewer);
      overlayHost.setVisible(TOWER_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Towers] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(TOWER_OVERLAY_SOURCE_ID, true);
      // disable() tears the camera listeners down; a re-enable must bring
      // them back or both horizon-culling and settle-refresh stay dead.
      _installCameraMoveRefresh(viewer || _viewer);
      _installClickHandler(viewer);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(TOWER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TOWER_OVERLAY_SOURCE_ID, false);
      _ambientEntries = [];
      _removeClickHandler();
      _clearSelection();
      _clearCameraMoveRefresh();
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const bounds = layerCameraBounds(viewer);
        // Edge-on / nadir views (and whole-globe far-outs) have no usable
        // viewport rectangle: nothing meaningful to query. Keep whatever is
        // already displayed rather than aborting the enable over it.
        if (!bounds) {
          _lastError = 'Zoom or tilt to a region to see cell towers.';
          return true;
        }
        const snapshot = await source.getSnapshot({
          signal: request.signal,
          bounds,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        if (snapshot?.keyRequired) {
          _dataAvailable = false;
          _dataSource.entities.removeAll();
          overlayHost.clearSource(TOWER_OVERLAY_SOURCE_ID);
          _count = 0;
          _lastUpdate = null;
          _lastError =
            'NO DATA — add OpenCelliD dump to .gev-cache/opencellid/';
          return true;
        }
        _dataAvailable = true;

        const rows = [];
        for (const [index, raw] of (snapshot?.towers ?? []).entries()) {
          const row = normalizeTowerRow(raw, index);
          if (row) rows.push(row);
        }

        const nextEntities = [];
        const overlayEntries = [];
        const nextPickIndex = new Map();

        for (const row of rows) {
          const cls = towerClass(row.radio);
          const color = towerColor(cls);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const entityId = `tower:${row.stableId}`;
          nextEntities.push(
            new Cesium.Entity({
              id: entityId,
              position,
              billboard: {
                image: towerIcon(),
                width: 24,
                height: 24,
                // The globe is hidden under Google Photorealistic 3D Tiles;
                // a bare height-0 anchor reads as floating wherever the real
                // terrain sits above sea level. Clamp to the tiles surface
                // exactly like the alpr/firms/earthquake ground markers.
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                color,
              },
              properties: {
                towerRow: row,
                towerClass: cls,
                towerStableId: row.stableId,
              },
            }),
          );
          nextPickIndex.set(entityId, {
            id: entityId,
            stableId: row.stableId,
            radio: row.radio,
            networkClass: cls,
            mcc: row.mcc,
            mnc: row.mnc,
            lac: row.lac,
            cell: row.cell,
            lat: row.lat,
            lon: row.lon,
            range: row.range,
            samples: row.samples,
            averageSignal: row.averageSignal,
            operator: row.operator,
            brand: row.brand,
            networkTypes: row.networkTypes,
            generations: row.generations,
            frequencyBands: row.frequencyBands,
          });
          overlayEntries.push(
            createTowerOverlayEntry({
              id: row.stableId,
              position,
              title: labelFor(row),
              towerClass: cls,
            }),
          );
        }

        _pickIndexById.clear();
        for (const [k, v] of nextPickIndex) _pickIndexById.set(k, v);

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        // Far-side icons must hide with the planet they sit on (see
        // _refreshHorizonCulling): without this a fresh fetch over a new
        // continent leaves the previous viewport's towers shining through.
        _refreshHorizonCulling();
        _ambientEntries = overlayEntries;
        if (_enabled) {
          _rebuildOverlayEntries();
        }

        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Towers] Updated: ${_count} towers in view`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Towers] Fetch error:', e);
        _lastError = e?.message || 'Tower source unavailable';
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
      _dataAvailable = true;
      overlayHost.clearSource(TOWER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TOWER_OVERLAY_SOURCE_ID, false);
      _ambientEntries = [];
      _clearCameraMoveRefresh();
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
     * Snapshot the layer's in-memory tower records as plain JSON-safe objects
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
              radio: p?.radio?.getValue?.(now) ?? p?.towerRow?.radio,
              mcc: p?.mcc?.getValue?.(now) ?? p?.towerRow?.mcc,
              mnc: p?.mnc?.getValue?.(now) ?? p?.towerRow?.mnc,
              lac: p?.lac?.getValue?.(now) ?? p?.towerRow?.lac,
              cell: p?.cell?.getValue?.(now) ?? p?.towerRow?.cell,
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
              range: p?.towerRow?.range,
            },
            result.length,
          ),
        );
      }
      return result;
    },

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
        const cell = p?.towerRow?.cell ?? p?.cell?.getValue?.(now);
        result.push({
          position,
          sourceId: String(cell ?? 'TOWER'),
          id: String(p?.towerStableId ?? entity.id),
          type: 'TWR',
          metric: String(p?.towerRow?.radio ?? ''),
        });
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        dataAvailable: _dataAvailable,
        error: _dataAvailable
          ? _lastError
          : 'NO DATA — add OpenCelliD dump to .gev-cache/opencellid/',
        keyRequired: !_dataAvailable,
      };
    },
  };
  // ── camera-driven refresh ────────────────────────────────────────────

  function _installCameraMoveRefresh(viewer) {
    if (!viewer) return;
    const camera = viewer.camera;
    if (!camera) return;
    if (!_cameraMoveEndRemover && camera.moveEnd?.addEventListener) {
      _cameraMoveEndRemover = camera.moveEnd.addEventListener(() => {
        // Settle first: cull far-side icons immediately, then fetch the new
        // viewport behind the debounce.
        _refreshHorizonCulling();
        _scheduleCameraMoveRefresh();
      });
    }
    if (!_cameraChangedRemover && camera.changed?.addEventListener) {
      // Cull DURING the spin, not just on settle: with the globe hidden in
      // the Google-3D regime nothing writes far-side depth, so without this
      // the old continent's towers ride along over the ocean mid-drag.
      _cameraChangedRemover = camera.changed.addEventListener(() => {
        _refreshHorizonCulling();
      });
    }
  }

  function _scheduleCameraMoveRefresh() {
    if (!_enabled) return;
    clearTimeout(_cameraMoveTimer);
    _cameraMoveTimer = setTimeout(() => {
      _cameraMoveTimer = null;
      if (!_enabled) return;
      void layer.update(_viewer);
    }, CAMERA_MOVE_DEBOUNCE_MS);
  }

  function _clearCameraMoveRefresh() {
    if (_cameraMoveEndRemover) {
      _cameraMoveEndRemover();
      _cameraMoveEndRemover = null;
    }
    if (_cameraChangedRemover) {
      _cameraChangedRemover();
      _cameraChangedRemover = null;
    }
    clearTimeout(_cameraMoveTimer);
    _cameraMoveTimer = null;
  }

  /**
   * Hide tower icons that have rotated behind the planet. Field-test pattern
   * from cctv (2026-07-06) and flights: the billboards are always-on-top
   * (`disableDepthTestDistance: INFINITY`, so low far-LOD mesh never swallows
   * them) and the Cesium globe is hidden under Google-3D tiles, so no depth
   * occludes the far side — an EllipsoidalOccluder pass must do it instead.
   * Pure math over ≤ query-limit points; safe to run on camera.changed.
   */
  function _refreshHorizonCulling() {
    if (!_viewer || !_dataSource) return;
    const camera = _viewer.camera;
    const camPos = camera?.positionWC;
    if (
      !camPos ||
      !Number.isFinite(camPos.x) ||
      !Number.isFinite(camPos.y) ||
      !Number.isFinite(camPos.z)
    )
      return;
    let occluder;
    try {
      occluder = horizonOccluder(camera);
    } catch {
      return;
    }
    if (typeof occluder?.isPointVisible !== 'function') return;
    const now = Cesium.JulianDate.now();
    for (const entity of _dataSource.entities.values) {
      let position = null;
      try {
        position = entity.position?.getValue?.(now, _cullScratch);
      } catch {
        position = null;
      }
      if (!position) continue;
      let visible = true;
      try {
        visible = occluder.isPointVisible(position);
      } catch {
        visible = true;
      }
      if (entity.show !== visible) entity.show = visible;
    }
  }
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
      const tower = _pickedTower(picked);
      if (tower) {
        _selectTower(tower);
        return;
      }
      if (picked) {
        const pickedId = resolvePickId?.(picked);
        if (pickedId && isOwnedByOtherLayer?.('towers', pickedId)) return;
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

  function _pickedTower(picked) {
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
    if (_selectedTower) {
      entries.push(
        buildSelectedTowerCard(
          _selectedTower,
          Cesium.Cartesian3.fromDegrees(_selectedTower.lon, _selectedTower.lat),
        ),
      );
    }
    overlayHost.setEntries(
      TOWER_OVERLAY_SOURCE_ID,
      selectTowerOverlayCohort(entries),
      {
        cohortLimit: TOWER_OVERLAY_COHORT_LIMIT,
        collisionCapacity: TOWER_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  function _selectTower(tower) {
    _selectedTower = tower;
    _rebuildOverlayEntries();
    if (!registerEntityContext) return;
    const recordId = `tower:${tower.stableId}`;
    try {
      const carrier = { show: true };
      registerEntityContext(carrier, {
        id: recordId,
        layerId: 'towers',
        layerName: 'Cell Towers',
        source: 'OpenCelliD',
        dataSource: _dataSource,
        label: `${tower.brand || tower.operator || 'Cell tower'} · ${tower.networkClass?.toUpperCase?.() || tower.radio || 'Cellular'}`,
        latitude: tower.lat,
        longitude: tower.lon,
        properties: {
          radio: tower.radio,
          mcc: tower.mcc,
          mnc: tower.mnc,
          lac: tower.lac,
          cell: tower.cell,
          operator: tower.operator,
          brand: tower.brand,
          networkTypes: tower.networkTypes,
          generations: tower.generations,
          frequencyBands: tower.frequencyBands,
        },
      });
      selectEntityContext?.(carrier);
    } catch {
      /* context store unavailable */
    }
  }

  function _clearSelection() {
    if (!_selectedTower) return;
    _selectedTower = null;
    _rebuildOverlayEntries();
    try {
      clearSelectedEntityContextForLayer?.('towers');
    } catch {
      /* context store unavailable */
    }
  }

  return layer;
}

/** Camera-view rectangle in degrees, or null when the camera is nadir/edge-on
 * (no usable viewport to bound the tower query). */
export function layerCameraBounds(viewer) {
  if (!viewer?.camera?.computeViewRectangle) return null;
  const rectangle = viewer.camera.computeViewRectangle(
    viewer.scene?.globe?.ellipsoid,
  );
  if (!rectangle) return null;
  const north = Cesium.Math.toDegrees(rectangle.north);
  const south = Cesium.Math.toDegrees(rectangle.south);
  const east = Cesium.Math.toDegrees(rectangle.east);
  const west = Cesium.Math.toDegrees(rectangle.west);
  if (![north, south, east, west].every(Number.isFinite)) return null;
  if (Math.abs(north - south) < 1e-6 || Math.abs(east - west) < 1e-6)
    return null;
  return { north, south, east, west };
}

/** Compact ambient label: operator brand when known, else the radio class. */
function labelFor(row) {
  const brand = row.brand || row.operator;
  if (brand) return brand;
  const cls = towerClass(row.radio);
  return cls === 'other' ? row.radio || 'CELL' : cls.toUpperCase();
}
