/** Bounded, renderer-independent OSM building geometry and factual summaries. */
export const BUILDING_LIMIT = 500;
export const LOAD_RADIUS_M = 600;
const R = 6371008.8;
const rad = Math.PI / 180;
export const USE_COLORS = {
  residential: '#bba0ff',
  commercial: '#ffcb77',
  civic: '#71dec8',
  industrial: '#87afff',
  unknown: '#8794a5',
};

export function distanceM(a, b) {
  const x =
    Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
    Math.cos(a[1] * rad) *
      Math.cos(b[1] * rad) *
      Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
}

/** Explicit map commands are local; open-ended questions go to the analyst. */
export function spatialQuestionKind(question) {
  const q = String(question)
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/g, '');
  if (
    /^(please )?(colou?r|highlight)( these| them| buildings| the buildings)? by (use|type|category)$/.test(
      q,
    )
  )
    return 'use';
  if (
    /^(which( one| building)? is (the )?tallest|show( me)? (the )?tallest( building)?)$/.test(
      q,
    )
  )
    return 'height';
  if (
    /^(how far apart( are (these|they|these buildings))?|compare( these| them| these buildings)?|what is the distance between (these|them|these buildings))$/.test(
      q,
    )
  )
    return 'distance';
  if (
    /^(what.s here|what is here|how many( buildings)?( are (here|selected|there))?)$/.test(
      q,
    )
  )
    return 'overview';
  return null;
}

export function validRing(input) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 2048)
    return null;
  const ring = input.map((p) => [Number(p?.[0]), Number(p?.[1])]);
  if (
    ring.some(
      (p) =>
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 85,
    )
  )
    return null;
  if (ring.some((p) => Math.abs(p[0] - ring[0][0]) > 180)) return null;
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
    ring.push([...ring[0]]);
  if (new Set(ring.map((p) => p.join(','))).size < 3 || ringArea(ring) < 1)
    return null;
  return ring;
}

export function ringArea(ring) {
  if (!ring?.length) return 0;
  const lat = ring[0][1] * rad;
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i],
      b = ring[i + 1];
    twice +=
      (a[0] - ring[0][0]) * (b[1] - ring[0][1]) -
      (b[0] - ring[0][0]) * (a[1] - ring[0][1]);
  }
  return (Math.abs(twice) * R * R * rad * rad * Math.cos(lat)) / 2;
}

function onSegment(p, a, b) {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
  return (
    Math.abs(cross) < 1e-12 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-10 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-10 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-10 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-10
  );
}

export function containsPoint(ring, p) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (onSegment(p, a, b)) return true;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function segmentsCross(a, b, c, d) {
  return (
    (orient(a, b, c) * orient(a, b, d) < 0 &&
      orient(c, d, a) * orient(c, d, b) < 0) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b)
  );
}
export function selfIntersects(ring) {
  for (let i = 0; i < ring.length - 1; i++)
    for (let j = i + 2; j < ring.length - 1; j++) {
      if (i === 0 && j === ring.length - 2) continue;
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1]))
        return true;
    }
  return false;
}

function bounds(ring) {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const [x, y] of ring) {
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, y);
    north = Math.max(north, y);
  }
  return [west, south, east, north];
}
const overlaps = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function intersectsRing(a, b) {
  if (!overlaps(bounds(a), bounds(b))) return false;
  if (a.some((p) => containsPoint(b, p)) || b.some((p) => containsPoint(a, p)))
    return true;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++)
      if (segmentsCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
  return false;
}

function parseHeight(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i);
  if (!match) return null;
  const n = Number(match[1]) * (/ft|feet/i.test(match[2] || '') ? 0.3048 : 1);
  return n > 0 && n <= 1000 ? n : null;
}
export function buildingHeight(tags = {}) {
  const height = parseHeight(tags.height);
  if (height)
    return {
      heightM: height,
      displayHeightM: height,
      heightSource: 'recorded height',
    };
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0 && levels <= 200)
    return {
      heightM: null,
      displayHeightM: levels * 3,
      heightSource: 'estimated from floors',
    };
  return {
    heightM: null,
    displayHeightM: 12,
    heightSource: 'display estimate',
  };
}
export function buildingUse(tags = {}) {
  const use = tags['building:use'] || tags.building || '';
  if (
    /^(apartments|residential|house|detached|terrace|dormitory|bungalow|semidetached_house)$/.test(
      use,
    )
  )
    return 'residential';
  if (/^(commercial|retail|office|hotel|supermarket)$/.test(use))
    return 'commercial';
  if (
    /^(civic|public|school|university|hospital|church|cathedral|mosque|synagogue|temple|government|train_station)$/.test(
      use,
    )
  )
    return 'civic';
  if (/^(industrial|warehouse|manufacture)$/.test(use)) return 'industrial';
  return 'unknown';
}
const clean = (value) => (typeof value === 'string' ? value.slice(0, 180) : '');
const coordRing = (geometry) => validRing(geometry?.map((p) => [p.lon, p.lat]));

/** Join relation fragments only when a closed ring exists. Never invent missing edges. */
function joinMembers(members, role) {
  const pieces = members
    .filter((m) => (m.role || 'outer') === role && Array.isArray(m.geometry))
    .map((m) => m.geometry.map((p) => [p.lon, p.lat]));
  const rings = [];
  const same = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
  while (pieces.length) {
    const line = pieces.shift();
    let changed = true;
    while (changed && !same(line[0], line.at(-1))) {
      changed = false;
      for (let i = 0; i < pieces.length; i++) {
        let next = pieces[i];
        if (same(line.at(-1), next.at(-1))) next = [...next].reverse();
        if (same(line.at(-1), next[0])) {
          line.push(...next.slice(1));
          pieces.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    if (same(line[0], line.at(-1))) {
      const ring = validRing(line);
      if (ring) rings.push(ring);
    }
  }
  return rings;
}

export function parseBuildings(payload, { limit = BUILDING_LIMIT } = {}) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const records = [],
    ownedWays = new Set(),
    seen = new Set();
  let skipped = 0;
  const add = (element, polygons) => {
    if (!polygons.length) {
      skipped++;
      return false;
    }
    const id = `osm:${element.type}/${element.id}`;
    if (seen.has(id)) return true;
    seen.add(id);
    const tags = element.tags || {};
    const box = bounds(polygons.flatMap((p) => p.outer));
    records.push({
      id,
      osmType: element.type,
      osmId: String(element.id),
      name:
        clean(tags.name) ||
        clean(tags['addr:housename']) ||
        `Building ${element.id}`,
      use: buildingUse(tags),
      recordedType: clean(tags['building:use'] || tags.building) || 'unknown',
      address: [tags['addr:housenumber'], tags['addr:street']]
        .map(clean)
        .filter(Boolean)
        .join(' '),
      ...buildingHeight(tags),
      polygons,
      bounds: box,
      center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
      footprintM2: Math.round(
        polygons.reduce(
          (n, p) =>
            n +
            ringArea(p.outer) -
            p.holes.reduce((s, h) => s + ringArea(h), 0),
          0,
        ),
      ),
    });
    return true;
  };
  for (const e of elements)
    if (e.type === 'relation' && e.tags?.building && e.tags.building !== 'no') {
      const outers = joinMembers(e.members || [], 'outer'),
        holes = joinMembers(e.members || [], 'inner');
      if (
        add(
          e,
          outers.map((outer) => ({
            outer,
            holes: holes.filter((h) => containsPoint(outer, h[0])),
          })),
        )
      )
        for (const m of e.members || [])
          if (m.type === 'way') ownedWays.add(String(m.ref));
    }
  for (const e of elements)
    if (
      e.type === 'way' &&
      e.tags?.building &&
      e.tags.building !== 'no' &&
      !ownedWays.has(String(e.id))
    ) {
      const ring = coordRing(e.geometry);
      add(e, ring ? [{ outer: ring, holes: [] }] : []);
    }
  return {
    records: records.slice(0, limit),
    truncated: records.length > limit,
    totalReceived: records.length,
    skipped,
    timestamp: payload?.osm3s?.timestamp_osm_base || null,
    incomplete: Boolean(payload?.remark),
  };
}

export function selectBuildings(records, ring, rule = 'intersects') {
  const box = bounds(ring);
  return records.filter(
    (r) =>
      overlaps(r.bounds, box) &&
      (rule === 'inside'
        ? r.polygons.every(
            (p) =>
              p.outer.every((v) => containsPoint(ring, v)) &&
              !ring.some(
                (a, i) =>
                  i &&
                  p.outer.some(
                    (b, j) =>
                      j &&
                      orient(ring[i - 1], a, p.outer[j - 1]) *
                        orient(ring[i - 1], a, b) <
                        0 &&
                      orient(p.outer[j - 1], b, ring[i - 1]) *
                        orient(p.outer[j - 1], b, a) <
                        0,
                  ),
              ),
          )
        : r.polygons.some(
            (p) =>
              intersectsRing(p.outer, ring) &&
              !p.holes.some((h) => ring.every((v) => containsPoint(h, v))),
          )),
  );
}

export function buildingFacts(records, center) {
  const categories = Object.fromEntries(
    Object.keys(USE_COLORS).map((k) => [k, 0]),
  );
  let knownHeights = 0,
    tallest = null,
    areaM2 = 0;
  for (const r of records) {
    categories[r.use]++;
    areaM2 += r.footprintM2;
    if (r.heightM !== null) {
      knownHeights++;
      if (!tallest || r.heightM > tallest.heightM) tallest = r;
    }
  }
  return {
    count: records.length,
    categories,
    knownHeights,
    unknownHeights: records.length - knownHeights,
    footprintM2: areaM2,
    pair:
      records.length === 2
        ? {
            from: records[0].id,
            to: records[1].id,
            distanceM: Math.round(
              distanceM(records[0].center, records[1].center),
            ),
            basis:
              'Horizontal straight-line distance between footprint bounding-box centers; not a walking route or wall-to-wall gap.',
          }
        : null,
    tallest: tallest
      ? { id: tallest.id, name: tallest.name, heightM: tallest.heightM }
      : null,
    evidence: records.map((r) => ({
      id: r.id,
      name: r.name,
      use: r.use,
      recordedType: r.recordedType,
      address: r.address,
      heightM: r.heightM,
      heightSource: r.heightSource,
      footprintM2: r.footprintM2,
      center: [...r.center],
      distanceM: center ? Math.round(distanceM(center, r.center)) : null,
    })),
  };
}
