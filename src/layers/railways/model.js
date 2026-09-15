import * as Cesium from 'cesium';
export const RAILWAY_OVERLAY_SOURCE_ID = 'railways';
export const RAILWAY_OVERLAY_COHORT_LIMIT = 240;
export const RAILWAY_OVERLAY_COLLISION_CAPACITY = 120;

/** Service-class label ranking — higher wins the ambient-label cohort. */
export const RAILWAY_CLASS_RANK = Object.freeze({
  rajdhani: 5,
  special: 4,
  express: 3,
  local: 2,
  passenger: 1,
  other: 0,
});

/**
 * Classify a RailRadar service code into a small stable band that drives both
 * the marker color and the label priority. Codes are short type abbreviations
 * (RAJDHANI, SHATABDI, SUPERFAST, EXPRESS, MEMU/DEMU, PASSENGER, SPECIAL).
 */
export function railwayClass(type) {
  const t = String(type || '').toUpperCase();
  if (t.includes('RAJ') || t.includes('SHAT')) return 'rajdhani';
  if ((t.includes('SUP') || t.includes('EXP')) && t.includes('SHT'))
    return 'special';
  if (t.includes('SUP') || t.includes('EXP')) return 'express';
  if (t.includes('MEMU') || t.includes('DEMU') || t.includes('LOCAL'))
    return 'local';
  if (t.includes('PAS')) return 'passenger';
  if (t.includes('SPL')) return 'special';
  return 'other';
}

export function railwayColor(trainClass) {
  switch (trainClass) {
    case 'rajdhani':
      return Cesium.Color.fromCssColorString('#d62828');
    case 'special':
      return Cesium.Color.fromCssColorString('#f48c06');
    case 'express':
      return Cesium.Color.fromCssColorString('#f9a03f');
    case 'local':
      return Cesium.Color.fromCssColorString('#2a9d8f');
    case 'passenger':
      return Cesium.Color.fromCssColorString('#7fb685');
    default:
      return Cesium.Color.fromCssColorString('#9aa5b1');
  }
}

/**
 * Build the source-owned presentation for one ambient train label. Train
 * numbers stay compact (e.g. "12301"); the class band colors the accent.
 * @param {object} input
 * @param {string} input.id Stable train number (or fallback id).
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {string} input.number Train number for the label title.
 * @param {string} input.trainClass Service-class band from railwayClass().
 * @returns {object}
 */
export function createRailwayOverlayEntry({
  id,
  position,
  number,
  trainClass,
}) {
  const cls = Object.hasOwn(RAILWAY_CLASS_RANK, trainClass)
    ? trainClass
    : 'other';
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(number),
    accent: railwayColor(cls).toCssColorString(),
    priority: RAILWAY_CLASS_RANK[cls],
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the most significant trains, with stable identity as the tie-break. */
export function selectRailwayOverlayCohort(
  entries,
  limit = RAILWAY_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(RAILWAY_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Defensively validate one /api/railways row before it can replace displayed
 * trains. The server already normalizes, so this only guards the contract
 * (finite coordinates, usable identity). Returns null to drop bad rows.
 * @param {Object|null|undefined} raw - {number, name, type, lat, lng,
 *   currentStation, currentStationName, nextStation, nextStationName, minsSinceDep}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 */
export function normalizeRailwayRow(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = (value) => {
    const t = String(value ?? '').trim();
    return t || null;
  };
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const number = text(raw.number);
  const name = text(raw.name);
  if (!number && !name) return null;
  const lat = num(raw.lat);
  const lng = num(raw.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null;
  return {
    stableId: number || `train-${index + 1}`,
    number: number || name,
    name: name || number,
    type: text(raw.type) || 'OTH',
    lat,
    lng,
    currentStation: text(raw.currentStation),
    currentStationName: text(raw.currentStationName),
    nextStation: text(raw.nextStation),
    nextStationName: text(raw.nextStationName),
    minsSinceDep: num(raw.minsSinceDep),
  };
}

/**
 * Card model for a click-selected train — the full-detail card, drawn last
 * (on top) and never distance-faded by the overlay.
 * @param {Object} train - Pick-index train record.
 * @param {Cesium.Cartesian3} position - Ground anchor.
 * @returns {Object} World-overlay entry.
 */
export function buildSelectedTrainCard(train, position) {
  const cls = train.railwayClass || railwayClass(train.type);
  const color = railwayColor(cls);
  const details = [];
  if (train.name && train.name !== train.number) details.push(train.name);
  if (train.type) details.push(train.type);
  const parts = [];
  if (train.currentStationName || train.currentStation)
    parts.push(`Now: ${train.currentStationName || train.currentStation}`);
  if (train.nextStationName || train.nextStation)
    parts.push(`Next: ${train.nextStationName || train.nextStation}`);
  if (parts.length) details.push(parts.join(' → '));
  return {
    id: `selected-railway:${train.stableId}`,
    actionable: true,
    position,
    gapPx: 20,
    accent: color.toCssColorString(),
    title: `TRAIN · ${train.number}`,
    details,
    selected: true,
    priority: Number.MAX_SAFE_INTEGER,
    variant: 'selected',
    protected: true,
    collisionGroup: 'ambient-label',
    cardStyle: 'tactical',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    interactive: true,
  };
}

/**
 * Map one train's raw plain values to a JSON-safe analyst record (analyst
 * query engine seam). Pure — no Cesium types. Missing/unknown fields are
 * null, never NaN/undefined.
 * @param {Object|null|undefined} raw - Plain values pulled off the entity:
 *   {id, number, name, type, lat, lon, currentStation, currentStationName,
 *   nextStation, nextStationName}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, number: string|null, name: string|null,
 *   trainClass: string|null, lat: number|null, lon: number|null,
 *   currentStation: string|null, currentStationName: string|null,
 *   nextStation: string|null, nextStationName: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (value) => (Number.isFinite(value) ? value : null);
  const text = (value) => {
    const t = String(value ?? '').trim();
    return t || null;
  };
  const trainNumber = text(raw?.number);
  const trainName = text(raw?.name);
  const type = text(raw?.type);
  return {
    id: trainNumber || `TRAIN-${String(index).padStart(4, '0')}`,
    number: trainNumber,
    name: trainName,
    trainClass: railwayClass(type),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    currentStation: text(raw?.currentStation),
    currentStationName: text(raw?.currentStationName),
    nextStation: text(raw?.nextStation),
    nextStationName: text(raw?.nextStationName),
  };
}
