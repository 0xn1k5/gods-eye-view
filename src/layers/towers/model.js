import * as Cesium from 'cesium';
export const TOWER_OVERLAY_SOURCE_ID = 'towers';
export const TOWER_OVERLAY_COHORT_LIMIT = 320;
export const TOWER_OVERLAY_COLLISION_CAPACITY = 160;

/** Network-generation rank — higher wins the ambient-label cohort. */
export const TOWER_CLASS_RANK = Object.freeze({
  '5g': 4,
  '4g': 3,
  '3g': 2,
  '2g': 1,
  other: 0,
});

/** Map an OpenCelliD `radio` value onto a stable display band. */
export function towerClass(radio) {
  const r = String(radio || '').toUpperCase();
  if (r.includes('NR')) return '5g';
  if (r.includes('LTE')) return '4g';
  if (r.includes('UMTS') || r.includes('HS')) return '3g';
  if (r.includes('GSM') || r.includes('GPRS') || r.includes('EDGE'))
    return '2g';
  if (r.includes('CDMA')) return '2g';
  return 'other';
}

export function towerColor(towerClass) {
  switch (towerClass) {
    case '5g':
      return Cesium.Color.fromCssColorString('#d62828');
    case '4g':
      return Cesium.Color.fromCssColorString('#2a9d8f');
    case '3g':
      return Cesium.Color.fromCssColorString('#f9a03f');
    case '2g':
      return Cesium.Color.fromCssColorString('#7fb685');
    default:
      return Cesium.Color.fromCssColorString('#9aa5b1');
  }
}

/**
 * Build the source-owned presentation for one ambient tower label. Generation
 * bands keep the accent colored by network class.
 * @param {object} input
 * @param {string} input.id Stable tower id (mcc:mnc:lac:cell:radio).
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {string} input.title Short label for the card title.
 * @param {string} input.towerClass Network band from towerClass().
 * @returns {object}
 */
export function createTowerOverlayEntry({ id, position, title, towerClass }) {
  const cls = Object.hasOwn(TOWER_CLASS_RANK, towerClass)
    ? towerClass
    : 'other';
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(title),
    accent: towerColor(cls).toCssColorString(),
    priority: TOWER_CLASS_RANK[cls],
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

/** Keep the most significant towers, with stable identity as the tie-break. */
export function selectTowerOverlayCohort(
  entries,
  limit = TOWER_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(TOWER_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * Defensively validate one tower row before it can replace displayed towers.
 * The server already normalizes, so this only guards the contract (finite
 * coordinates, usable identity, network radio). Returns null to drop bad rows.
 * @param {Object|null|undefined} raw - {radio, mcc, mnc, lac, cell, lat, lon,
 *   range, samples, averageSignal, operator, brand, networkTypes,
 *   frequencyBands, generations, countryIso, label}.
 * @param {number} [index=0] - Position in the response (fallback id only).
 */
export function normalizeTowerRow(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = (value) => {
    const t = String(value ?? '').trim();
    return t || null;
  };
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const radio = text(raw.radio);
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  const mcc = text(raw.mcc) || '?';
  const mnc = text(raw.mnc) || '?';
  const lac = text(raw.lac) || '?';
  const cell = text(raw.cell) || '?';
  const stableId = `${mcc}:${mnc}:${lac}:${cell}:${radio || 'RAD'}`;
  return {
    stableId,
    id: stableId,
    radio: radio || 'UNKNOWN',
    networkClass: towerClass(radio),
    mcc,
    mnc,
    lac,
    cell,
    lat,
    lon,
    range: num(raw.range),
    samples: num(raw.samples),
    averageSignal: num(raw.averageSignal),
    operator: raw.operator ?? null,
    brand: raw.brand ?? null,
    networkTypes: raw.networkTypes ?? null,
    frequencyBands: raw.frequencyBands ?? null,
    generations: raw.generations ?? null,
    countryIso: raw.countryIso ?? null,
    label: raw.label ?? null,
  };
}

/**
 * Card model for a click-selected tower — the full-detail card, drawn last
 * (on top) and never distance-faded by the overlay.
 * @param {Object} tower - Pick-index tower record.
 * @param {Cesium.Cartesian3} position - Ground anchor.
 * @returns {Object} World-overlay entry.
 */
export function buildSelectedTowerCard(tower, position) {
  const cls = tower.networkClass || towerClass(tower.radio);
  const color = towerColor(cls);
  const details = [];
  if (tower.radio) details.push(`Network: ${tower.radio}`);
  if (tower.mcc !== '?' || tower.mnc !== '?')
    details.push(`MCC/MNC: ${tower.mcc}/${tower.mnc}`);
  const idParts = [];
  if (tower.lac !== '?') idParts.push(`LAC ${tower.lac}`);
  if (tower.cell !== '?') idParts.push(`Cell ${tower.cell}`);
  if (idParts.length) details.push(idParts.join(' · '));
  if (Number.isFinite(tower.range))
    details.push(`Est. range: ${formatRange(tower.range)}`);
  if (Number.isFinite(tower.averageSignal))
    details.push(`Avg signal: ${tower.averageSignal} dBm`);
  if (Number.isFinite(tower.samples)) details.push(`Samples: ${tower.samples}`);
  const title =
    tower.label ||
    [
      tower.brand || tower.operator || null,
      `TOWER · ${tower.networkClass?.toUpperCase?.() || 'CELL'}`,
    ]
      .filter(Boolean)
      .join(' ');
  return {
    id: `selected-tower:${tower.stableId}`,
    actionable: true,
    position,
    gapPx: 20,
    accent: color.toCssColorString(),
    title,
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

function formatRange(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} m`;
  return `${(value / 1000).toFixed(1)} km`;
}

/**
 * Map one tower's raw plain values to a JSON-safe analyst record (analyst
 * query engine seam). Pure — no Cesium types. Missing/unknown fields are
 * null, never NaN/undefined.
 * @param {Object|null|undefined} raw - {radio, mcc, mnc, lac, cell, lat, lon,
 *   range, samples, averageSignal, label}.
 * @param {number} [index=0] - Position in the response (fallback id only).
 * @returns {{id: string, networkClass: string|null, radio: string|null,
 *   mcc: string|null, mnc: string|null, lac: string|null, cell: string|null,
 *   lat: number|null, lon: number|null, range: number|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (value) => (Number.isFinite(value) ? value : null);
  const text = (value) => {
    const t = String(value ?? '').trim();
    return t || null;
  };
  const radio = text(raw?.radio);
  const mcc = text(raw?.mcc);
  const mnc = text(raw?.mnc);
  const lac = text(raw?.lac);
  const cell = text(raw?.cell);
  return {
    id:
      mcc && mnc && lac && cell
        ? `${mcc}:${mnc}:${lac}:${cell}:${radio || 'RAD'}`
        : `TOWER-${String(index).padStart(4, '0')}`,
    networkClass: towerClass(radio),
    radio,
    mcc,
    mnc,
    lac,
    cell,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    range: num(raw?.range),
  };
}
