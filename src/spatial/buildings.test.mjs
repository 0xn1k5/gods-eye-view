import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validRing,
  ringArea,
  containsPoint,
  selfIntersects,
  intersectsRing,
  buildingHeight,
  parseBuildings,
  selectBuildings,
  buildingFacts,
  spatialQuestionKind,
} from './buildings.js';

const box = (x, y, width = 0.001) => [
  [x, y],
  [x + width, y],
  [x + width, y + width],
  [x, y + width],
  [x, y],
];
const way = (id, ring, tags = {}) => ({
  type: 'way',
  id,
  tags: { building: 'yes', ...tags },
  geometry: ring.map(([lon, lat]) => ({ lon, lat })),
});

test('point containment includes edges but excludes the rest of the plane for a closed ring', () => {
  const r = box(0, 0);
  assert.equal(containsPoint(r, [0.0005, 0.0005]), true);
  assert.equal(containsPoint(r, [1, 1]), false);
  assert.equal(containsPoint(r, [0, 0.0005]), true);
});
test('geometry validity, meter area and crossing detection', () => {
  assert.ok(Math.abs(ringArea(box(0, 0)) - 12364) < 10);
  assert.equal(
    validRing([
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
    null,
  );
  assert.equal(
    validRing([
      [179, 0],
      [-179, 0],
      [179, 1],
    ]),
    null,
  );
  assert.equal(
    validRing([
      [0, NaN],
      [1, 0],
      [1, 1],
    ]),
    null,
  );
  assert.equal(
    selfIntersects([
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
      [0, 0],
    ]),
    true,
  );
  assert.equal(selfIntersects(box(0, 0)), false);
});
test('crossing rectangles intersect even when neither has a contained corner', () => {
  const a = [
      [-2, -0.1],
      [2, -0.1],
      [2, 0.1],
      [-2, 0.1],
      [-2, -0.1],
    ],
    b = [
      [-0.1, -2],
      [0.1, -2],
      [0.1, 2],
      [-0.1, 2],
      [-0.1, -2],
    ];
  assert.equal(intersectsRing(a, b), true);
  assert.equal(intersectsRing(box(0, 0), box(1, 1)), false);
});
test('display estimates never masquerade as recorded heights', () => {
  assert.deepEqual(buildingHeight({ 'building:levels': '7' }), {
    heightM: null,
    displayHeightM: 21,
    heightSource: 'estimated from floors',
  });
  assert.equal(buildingHeight({ height: '100 ft' }).heightM, 30.48);
  assert.equal(buildingHeight({ height: '12;18' }).heightM, null);
  assert.equal(buildingHeight({ height: '10000' }).heightM, null);
});
test('OSM identities deduplicate, missing tags remain unknown, limit is explicit', () => {
  const p = parseBuildings(
    {
      elements: [
        way(1, box(0, 0)),
        way(1, box(0, 0)),
        way(2, box(0.003, 0), { building: 'office', height: '42' }),
      ],
    },
    { limit: 1 },
  );
  assert.equal(p.records.length, 1);
  assert.equal(p.totalReceived, 2);
  assert.equal(p.truncated, true);
  assert.equal(p.records[0].use, 'unknown');
});
test('relations join reversed fragments, retain courtyards, and suppress their member ways', () => {
  const r = box(0, 0, 0.01),
    h = box(0.002, 0.002, 0.002);
  const members = [
    {
      type: 'way',
      ref: 1,
      role: 'outer',
      geometry: r.slice(0, 3).map(([lon, lat]) => ({ lon, lat })),
    },
    {
      type: 'way',
      ref: 2,
      role: 'outer',
      geometry: [r[0], r[3], r[2]].map(([lon, lat]) => ({ lon, lat })),
    },
    {
      type: 'way',
      ref: 3,
      role: 'inner',
      geometry: h.map(([lon, lat]) => ({ lon, lat })),
    },
  ];
  const parsed = parseBuildings({
    elements: [
      { type: 'relation', id: 9, tags: { building: 'school' }, members },
      way(1, r),
    ],
  });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].polygons[0].holes.length, 1);
  assert.equal(parsed.records[0].use, 'civic');
  assert.equal(
    selectBuildings(parsed.records, box(0.0022, 0.0022, 0.001)).length,
    0,
  );
});
test('inside and intersection selection differ at the boundary', () => {
  const { records } = parseBuildings({
    elements: [way(1, box(0, 0)), way(2, box(0.0015, 0))],
  });
  const selection = box(-0.0001, -0.0001, 0.002);
  assert.equal(selectBuildings(records, selection, 'intersects').length, 2);
  assert.equal(selectBuildings(records, selection, 'inside').length, 1);
});
test('summaries use selected records and recorded heights only', () => {
  const { records } = parseBuildings({
    elements: [
      way(1, box(0, 0), { 'building:levels': '100' }),
      way(2, box(0.003, 0), { height: '30', building: 'office' }),
    ],
  });
  const f = buildingFacts(records, [0, 0]);
  assert.equal(f.count, 2);
  assert.equal(f.unknownHeights, 1);
  assert.equal(f.tallest.id, 'osm:way/2');
  assert.equal(f.categories.commercial, 1);
});

test('explicit map commands stay local while open-ended questions remain model questions', () => {
  assert.equal(spatialQuestionKind('Color these by use'), 'use');
  assert.equal(spatialQuestionKind('Which is tallest?'), 'height');
  assert.equal(spatialQuestionKind('How far apart are these?'), 'distance');
  assert.equal(spatialQuestionKind('Why is this building so tall?'), null);
  assert.equal(spatialQuestionKind('Do not color these by use'), null);
});
test('two-building comparison is a bounded horizontal center distance', () => {
  const { records } = parseBuildings({
    elements: [way(1, box(0, 0)), way(2, box(0.001, 0))],
  });
  const f = buildingFacts(records, [0, 0]);
  assert.equal(f.pair.distanceM, 111);
  assert.deepEqual(f.evidence[0].center, [0.0005, 0.0005]);
  assert.equal(buildingFacts(records.slice(0, 1)).pair, null);
});
