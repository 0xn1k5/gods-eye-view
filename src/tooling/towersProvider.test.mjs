import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  towersProxy,
  parseOpenCelliDRow,
  buildTowerIndexFromDisk,
  createHeap,
  queryTowerIndex,
  queryBounds,
  mccNetworkFor,
  TOWER_MAX_QUERY_LIMIT,
  MCC_MNC_NETWORKS,
} from 'gods-eye-view/server/providers/towers';
import { towerBoundsQuery } from 'gods-eye-view/layers/towers/source';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = String(body);
      },
    };
    await routes.get(route)(
      { url: url.slice(route.length) || '/', method },
      res,
    );
    return res;
  };
}

const HEADER =
  'radio,mcc,mnc,lac,cid,unit,lon,lat,range,samples,changeable,created,updated,avgSignal';
const TOWER_LINES = [
  'LTE,310,410,1001,2001,0,-97.74,30.27,1080,45,0,2024-01-01,2026-01-01,-78',
  'NR,310,410,1001,3001,0,-97.74,30.28,800,91,0,2025-06-01,2026-02-01,-74',
  'GSM,310,410,1002,4001,0,-97.60,30.10,2850,200,0,2023-01-01,2026-01-01,-83',
  'LTE,262,01,1234,5678,0,13.40,52.52,1500,37,0,2024-05-01,2026-01-01,-71',
  'UMTS,310,410,1001,9999,0,-97.80,30.20,920,12,0,2024-03-01,2026-01-01,-85',
];

test('parseOpenCelliDRow decodes the fixed export columns and rejects header/bad rows', () => {
  assert.equal(parseOpenCelliDRow(HEADER), null, 'header drops');
  assert.equal(parseOpenCelliDRow(''), null);
  assert.equal(parseOpenCelliDRow('   \n'), null);
  const row = parseOpenCelliDRow(TOWER_LINES[0]);
  assert.deepEqual(row, {
    id: '310:410:1001:2001:LTE',
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
  });
  assert.equal(
    parseOpenCelliDRow('LTE,310,410,1001,2001,0,abcd,30.27,...'),
    null,
  );
  assert.equal(parseOpenCelliDRow('LTE,310,410'), null);
  assert.equal(
    parseOpenCelliDRow('LTE,310,410,1001,2001,0,-97.7,91.0,1,2,0,a,b,c'),
    null,
    'lat > 90 drops',
  );
});

test('buildTowerIndexFromDisk keeps the most-measured cap and indexes into grid cells', async () => {
  const heap = createHeap(3);
  for (const line of TOWER_LINES) heap.push(parseOpenCelliDRow(line));
  assert.equal(heap.size, 3, 'cap enforced');
  assert.deepEqual(
    heap.rows.map((row) => row.samples).sort((a, b) => b - a),
    [200, 91, 45],
    'keeps the three most-measured towers (GSM200, NR91, LTE45)',
  );

  const index = await buildTowerIndexFromDisk({
    files: [{ stream: Readable.from([`${TOWER_LINES.join('\n')}\n`]) }],
    cap: 10,
    gridDegrees: 1,
  });
  assert.ok(index, 'a readable dump yields an index');
  assert.equal(index.rows.length, 5);
  assert.equal(index.gridDegrees, 1);

  const india = await buildTowerIndexFromDisk({
    files: [{ stream: Readable.from([`${TOWER_LINES.join('\n')}\n`]) }],
    cap: 10,
    gridDegrees: 1,
    mccs: new Set(['262']),
  });
  assert.ok(india, 'index still builds with an MCC filter');
  assert.deepEqual(
    india.rows.map((row) => row.id),
    ['262:01:1234:5678:LTE'],
    'mccs keeps only the matching mobile country code',
  );

  const empty = await buildTowerIndexFromDisk({
    files: [{ stream: Readable.from([`${TOWER_LINES.join('\n')}\n`]) }],
    cap: 10,
    mccs: new Set(['999']),
  });
  assert.equal(
    empty,
    null,
    'mccs yielding no rows drops the file like an empty dump',
  );
});

test('buildTowerIndexFromDisk merges multiple readable dumps into one index', async () => {
  const index = await buildTowerIndexFromDisk({
    files: [
      {
        stream: Readable.from([`${TOWER_LINES.slice(0, 3).join('\n')}\n`]),
        label: '310.csv.gz',
      },
      {
        stream: Readable.from([`${TOWER_LINES.slice(2).join('\n')}\n`]),
        label: '989.csv.gz',
      },
      { stream: Readable.from(['bad-gzip-bytes\n']) },
    ],
    cap: 10,
    gridDegrees: 1,
  });
  assert.ok(
    index,
    'merging readable dumps plus one unreadable still yields an index',
  );
  assert.equal(
    index.rows.length,
    5,
    'overlapping rows stay id-unique across files',
  );
  assert.equal(
    index.file,
    '310.csv.gz, 989.csv.gz',
    'file label lists the merged dumps',
  );
});

test('queryTowerIndex filters by rectangle and sorts most-measured first', () => {
  const index = {
    gridDegrees: 1,
    rows: TOWER_LINES.map(parseOpenCelliDRow),
    byCell: {},
  };
  // hand-build the same grid the builder makes: lat floor / lon floor keys
  index.rows.forEach((row, i) => {
    const key = `${Math.floor(row.lat)}:${Math.floor(row.lon)}`;
    (index.byCell[key] ??= []).push(i);
  });
  index.gridCells = Object.keys(index.byCell).length;

  const austin = queryTowerIndex(
    index,
    queryBounds(
      new URLSearchParams({
        neLat: '30.4',
        neLng: '-97.5',
        swLat: '30',
        swLng: '-97.9',
      }),
    ),
    10,
  );
  assert.deepEqual(
    austin.map((row) => row.cell),
    ['4001', '3001', '2001', '9999'],
    'Austin-only towers, by samples (200, 91, 45, 12)',
  );

  const gerry = queryTowerIndex(
    index,
    queryBounds(
      new URLSearchParams({
        neLat: '52.6',
        neLng: '13.5',
        swLat: '52.4',
        swLng: '13.3',
      }),
    ),
    5,
  );
  assert.deepEqual(
    gerry.map((row) => row.cell),
    ['5678'],
  );
});

test('queryBounds normalizes swapped corners and clamps latitude/longitude', () => {
  const bounds = queryBounds(
    new URLSearchParams({
      neLat: '30',
      neLng: '-97.9',
      swLat: '30.4',
      swLng: '-97.5',
    }),
  );
  assert.deepEqual(bounds, {
    north: 30.4,
    south: 30,
    east: -97.5,
    west: -97.9,
  });
  assert.equal(queryBounds(new URLSearchParams({ neLat: 'x' })), null);
  assert.equal(
    queryBounds(
      new URLSearchParams({ neLat: '30', neLng: '0', swLat: '30', swLng: '0' }),
    ),
    null,
    'zero-area rectangle rejects',
  );
  const clamped = queryBounds(
    new URLSearchParams({
      neLat: '120',
      neLng: '200',
      swLat: '-10',
      swLng: '-200',
    }),
  );
  assert.deepEqual(clamped, { north: 90, south: -10, east: 180, west: -180 });
});

test('towerBoundsQuery serializes a camera rectangle into bbox params', () => {
  assert.equal(
    towerBoundsQuery({ north: 30.4, south: 30, east: -97.5, west: -97.9 }),
    '?neLat=30.4&neLng=-97.5&swLat=30&swLng=-97.9',
  );
  assert.equal(towerBoundsQuery({ north: 30.4 }), '');
  assert.equal(towerBoundsQuery(null), '');
  assert.equal(
    towerBoundsQuery({ north: 30.4, south: 30.4, east: 0, west: 0 }),
    '',
    'zero-area rectangle yields no query',
  );
});

test('mccNetworkFor joins the bundled mcc-mnc.org table on numeric pairs', () => {
  const at = mccNetworkFor('310', '410');
  assert.ok(at, 'US AT&T 310-410 is present');
  assert.equal(at.brand, 'AT&T');
  const de = mccNetworkFor('262', '01');
  assert.ok(de, 'T-Mobile Deutschland 262-01 is present');
  assert.equal(de.iso, 'DE');
  assert.equal(mccNetworkFor('999', '999'), null);
  const padded = mccNetworkFor('404', '02');
  assert.equal(
    typeof padded,
    'object',
    'zero-padding ignored, MNC 02 resolves',
  );
});

test('proxy answers bbox snapshots and reports no_data without a dump', async () => {
  process.env.OPENCELLID_MAX_TOWERS = '10';
  process.env.OPENCELLID_CACHE_DIR = mkdtempSync(join(tmpdir(), 'gev-towers-'));
  try {
    const plugin = towersProxy();
    const request = install(plugin);

    // Point it at a nonexistent file → 503 no_data.
    process.env.OPENCELLID_CSV_PATH = '/definitely/not/here.csv';
    const missing = await request(
      '/api/towers',
      '/api/towers?neLat=30.4&neLng=-97.5&swLat=30&swLng=-97.9',
    );
    assert.equal(missing.status, 503);
    assert.equal(JSON.parse(missing.body).error, 'no_data');

    // Status endpoint reports the empty state with a matching message. The
    // middleware owns the whole /api/towers subtree, so dispatch subpaths
    // through the same route.
    const status = await request('/api/towers', '/api/towers/status');
    assert.equal(status.status, 200);
    assert.deepEqual(JSON.parse(status.body), {
      hasData: false,
      file: null,
      rows: 0,
      gridCells: 0,
      mccNetworks: Object.keys(MCC_MNC_NETWORKS).length,
      cap: 10,
    });
  } finally {
    delete process.env.OPENCELLID_CSV_PATH;
    delete process.env.OPENCELLID_MAX_TOWERS;
    delete process.env.OPENCELLID_CACHE_DIR;
  }
});

test('query limit clamps to the server-side maximum', () => {
  const index = {
    gridDegrees: 1,
    rows: Array.from({ length: TOWER_MAX_QUERY_LIMIT + 10 }, (_, i) => ({
      id: `t:${i}`,
      radio: 'LTE',
      mcc: '310',
      mnc: '410',
      lac: '1',
      cell: String(i),
      lat: 30.2 + (i % 100) * 1e-4,
      lon: -97.7 + (i % 100) * 1e-4,
      samples: 1,
    })),
    byCell: {},
  };
  index.rows.forEach((row, i) => {
    const key = `${Math.floor(row.lat)}:${Math.floor(row.lon)}`;
    (index.byCell[key] ??= []).push(i);
  });
  const bounds = queryBounds(
    new URLSearchParams({
      neLat: '30.21',
      neLng: '-97.69',
      swLat: '30.2',
      swLng: '-97.7',
    }),
  );
  const many = queryTowerIndex(index, bounds, 999_999);
  assert.equal(many.length, TOWER_MAX_QUERY_LIMIT, 'never exceeds the cap');
});
