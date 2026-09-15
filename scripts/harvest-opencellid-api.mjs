/**
 * Harvest OpenCelliD cells via the bbox API for regions whose CSV exports are
 * policy-blocked (India MCC 404/405 have no per-country or world-dump slice —
 * staff: "waiting for clarity on India's Geospatial policy" — but the API
 * serves them fine).
 *
 * Tiles the region in <=4 km^2 bboxes (the API cap), splits adaptively when a
 * tile hits the per-request cell limit, dedupes by cell key, and writes rows
 * in the exact 14-column schema the towers proxy already ingests:
 *   radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal
 *
 * Quota-paced with checkpoint/resume so a multi-day whole-country grind can
 * run a slice per day:
 *
 *   OPENCELLID_TOKEN=pk.xxxx node scripts/harvest-opencellid-api.mjs --metro=delhi
 *   OPENCELLID_TOKEN=pk.xxxx node scripts/harvest-opencellid-api.mjs --india
 *   OPENCELLID_TOKEN=pk.xxxx node scripts/harvest-opencellid-api.mjs --bbox=28.4,76.9,28.9,77.4 --daily-cap=200
 *
 * State lives in .gev-cache/opencellid/.harvest-<tag>.json; staged rows in
 * .harvest-<tag>.jsonl. --finalize folds the staging file into <mcc>.csv.gz
 * files the proxy picks up on next restart/request.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = fileURLToPath(new URL('..', import.meta.url));
const cacheDir = path.join(root, '.gev-cache', 'opencellid');

// OpenCelliD getInArea caps one bbox at 4 km^2. Tile at ~2x2 km with margin.
const TILE_KM = 1.9;
const KM_PER_DEG_LAT = 111.32;
const API_LIMIT = 1000;
const MIN_TILE_DEG = 0.0008; // stop splitting below ~90 m tiles
const REQUEST_DELAY_MS = 1100;

const METROS = {
  delhi: [28.35, 76.85, 28.9, 77.35],
  mumbai: [18.85, 72.75, 19.3, 73.05],
  bangalore: [12.85, 77.45, 13.15, 77.75],
  hyderabad: [17.25, 78.25, 17.55, 78.6],
  chennai: [12.85, 80.1, 13.15, 80.3],
  kolkata: [22.45, 88.25, 22.75, 88.5],
  pune: [18.4, 73.75, 18.65, 74.0],
  ahmedabad: [22.9, 72.45, 23.15, 72.7],
};

// Generous land-covering boxes (overlaps are fine — rows dedupe by cell key).
const INDIA_BOXES = [
  [20.0, 68.2, 24.7, 74.5], // Gujarat
  [23.0, 69.5, 30.2, 78.2], // Rajasthan
  [27.5, 73.8, 32.5, 79.0], // Punjab/Haryana/Delhi
  [28.5, 74.5, 33.2, 81.0], // HP/Uttarakhand
  [32.2, 72.5, 37.0, 80.5], // J&K/Ladakh
  [23.8, 77.0, 30.5, 84.7], // UP
  [24.2, 83.3, 27.5, 88.2], // Bihar
  [21.5, 85.8, 27.2, 90.0], // West Bengal
  [21.8, 89.7, 29.5, 97.4], // North-East
  [21.0, 74.0, 26.9, 82.8], // MP
  [15.6, 72.5, 22.1, 80.9], // Maharashtra/Goa
  [17.8, 81.3, 22.6, 87.5], // Odisha
  [17.8, 80.2, 24.1, 84.4], // Chhattisgarh
  [12.6, 76.7, 19.9, 84.8], // AP/Telangana
  [11.5, 74.0, 18.5, 78.6], // Karnataka
  [8.0, 76.0, 13.6, 80.3], // Tamil Nadu
  [8.2, 74.5, 12.8, 77.5], // Kerala
];

function parseArgs() {
  const args = {
    mcc: '404,405',
    dailyCap: 900,
    metro: null,
    india: false,
    bbox: null,
    finalize: false,
    tag: null,
  };
  for (const raw of process.argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'mcc') args.mcc = value;
    else if (key === 'daily-cap')
      args.dailyCap = Math.max(1, Number(value) || 900);
    else if (key === 'metro') args.metro = value;
    else if (key === 'india') args.india = true;
    else if (key === 'bbox') args.bbox = value.split(',').map(Number);
    else if (key === 'finalize') args.finalize = true;
    else if (key === 'tag') args.tag = value;
  }
  return args;
}

function tileBox([minLat, minLon, maxLat, maxLon]) {
  const tiles = [];
  const midLat = (minLat + maxLat) / 2;
  const dLat = TILE_KM / KM_PER_DEG_LAT;
  const dLon = TILE_KM / (KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));
  for (let lat = minLat; lat < maxLat; lat += dLat) {
    for (let lon = minLon; lon < maxLon; lon += dLon) {
      tiles.push([
        lat,
        lon,
        Math.min(lat + dLat, maxLat),
        Math.min(lon + dLon, maxLon),
      ]);
    }
  }
  return tiles;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function fetchCells(token, bbox, mcc, attempts = 4) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const params = new URLSearchParams({
    key: token,
    BBOX: `${minLat},${minLon},${maxLat},${maxLon}`,
    mcc,
    limit: String(API_LIMIT),
    format: 'json',
  });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // curl, not fetch: Node's bundled undici consistently times out
      // connecting to opencellid.org (Cloudflare) from this network while
      // curl succeeds — validated 2026-09-16.
      const { stdout } = await execFileAsync(
        'curl',
        [
          '-s',
          '--max-time',
          '60',
          `https://opencellid.org/cell/getInArea?${params}`,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const body = JSON.parse(stdout);
      if (body.error) throw new Error(`API: ${body.error}`);
      return body.cells ?? [];
    } catch (error) {
      lastError = error;
      await sleep(2500 * attempt);
    }
  }
  throw lastError;
}

function cellKey(c) {
  return `${c.mcc}:${c.mnc}:${c.lac ?? c.tac ?? 0}:${c.cellid ?? c.cid ?? 0}:${c.radio}`;
}

function toRow(c) {
  const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const lat = Number(c.lat);
  const lon = Number(c.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [
    c.radio || 'UNKNOWN',
    num(c.mcc),
    num(c.mnc),
    num(c.lac ?? c.tac),
    num(c.cellid ?? c.cid),
    num(c.rnc ?? c.nid),
    lon,
    lat,
    num(c.range),
    num(c.samples),
    num(c.changeable, 1),
    num(c.created),
    num(c.updated),
    num(c.averageSignalStrength),
  ].join(',');
}

async function main() {
  const args = parseArgs();
  const token = String(process.env.OPENCELLID_TOKEN || '').trim();
  await fsp.mkdir(cacheDir, { recursive: true });

  const tag =
    args.tag ||
    args.metro ||
    (args.india ? 'india' : args.bbox ? 'bbox' : 'custom');
  const statePath = path.join(cacheDir, `.harvest-${tag}.json`);
  const stagePath = path.join(cacheDir, `.harvest-${tag}.jsonl`);

  if (args.finalize) {
    await finalize(stagePath);
    return;
  }
  if (!/^pk\./.test(token)) {
    console.error(
      'Missing OPENCELLID_TOKEN=pk.yourtoken (same free token as downloads).',
    );
    process.exit(1);
  }

  let boxes;
  if (args.metro) {
    if (!METROS[args.metro])
      throw new Error(
        `Unknown metro. Choices: ${Object.keys(METROS).join(', ')}`,
      );
    boxes = [METROS[args.metro]];
  } else if (args.india) {
    boxes = INDIA_BOXES;
  } else if (args.bbox) {
    boxes = [args.bbox];
  } else {
    throw new Error(
      'Pass one of --metro=name, --india, or --bbox=minLat,minLon,maxLat,maxLon.',
    );
  }

  let state = {
    queue: [],
    seen: 0,
    cells: 0,
    used: 0,
    day: new Date().toISOString().slice(0, 10),
  };
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    } catch {
      /* restart with fresh queue */
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.used = 0;
  }
  const seen = new Set();
  if (existsSync(stagePath)) {
    for (const line of (await fsp.readFile(stagePath, 'utf8')).split('\n')) {
      if (line) seen.add(line.split('|', 1)[0]);
    }
  }
  if (!state.queue.length) {
    state.queue = boxes.flatMap(tileBox);
    console.log(`Queued ${state.queue.length} tiles for ${tag}.`);
  } else {
    console.log(
      `Resuming ${tag}: ${state.queue.length} tiles left, ${seen.size} cells staged.`,
    );
  }

  const stage = createWriteStream(stagePath, { flags: 'a' });
  const mccs = args.mcc
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let budget = Math.max(0, args.dailyCap - state.used);

  const splitTile = ([a, b, c, d]) => {
    const mLat = (a + c) / 2;
    const mLon = (b + d) / 2;
    return [
      [a, b, mLat, mLon],
      [a, mLon, mLat, d],
      [mLat, b, c, mLon],
      [mLat, mLon, c, d],
    ];
  };

  while (state.queue.length && budget > 0) {
    const tile = state.queue.shift();
    const [a, b, c, d] = tile;
    let tileCells = [];
    try {
      for (const mcc of mccs) {
        // eslint-disable-next-line no-await-in-loop
        const cells = await fetchCells(token, tile, mcc);
        // eslint-disable-next-line no-await-in-loop
        await sleep(REQUEST_DELAY_MS);
        tileCells.push(...cells);
      }
      state.used += mccs.length;
      budget -= mccs.length;
    } catch (error) {
      console.error(
        `tile [${tile.map((v) => v.toFixed(4))}] failed (${error.message}) — requeued`,
      );
      state.queue.unshift(tile);
      break;
    }
    if (
      tileCells.length >= API_LIMIT * mccs.length &&
      c - a > MIN_TILE_DEG &&
      d - b > MIN_TILE_DEG
    ) {
      state.queue.unshift(...splitTile(tile)); // dense: subdivide, no extra cost yet
      continue;
    }
    let added = 0;
    for (const cell of tileCells) {
      const key = cellKey(cell);
      if (seen.has(key)) continue;
      const row = toRow(cell);
      if (!row) continue;
      seen.add(key);
      stage.write(`${key}|${row}\n`);
      added += 1;
    }
    state.cells = seen.size;
    state.seen += 1;
    if (state.seen % 25 === 0) {
      console.log(
        `${tag}: ${state.seen} tiles probed, ${seen.size} cells staged, budget left ${budget}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await fsp.writeFile(statePath, JSON.stringify(state));
    }
  }
  stage.end();
  await fsp.writeFile(statePath, JSON.stringify(state));
  console.log(
    `Done for now: ${state.queue.length} tiles left, ${seen.size} cells staged. Run --finalize to fold into <mcc>.csv.gz.`,
  );
}

async function finalize(stagePath) {
  if (!existsSync(stagePath)) {
    console.error(`Nothing staged at ${stagePath}`);
    process.exit(1);
  }
  const byMcc = new Map();
  const seen = new Set();
  for (const line of (await fsp.readFile(stagePath, 'utf8')).split('\n')) {
    if (!line) continue;
    const sep = line.indexOf('|');
    const key = line.slice(0, sep);
    if (seen.has(key)) continue;
    seen.add(key);
    const mcc = key.split(':', 1)[0];
    if (!byMcc.has(mcc)) byMcc.set(mcc, []);
    byMcc.get(mcc).push(line.slice(sep + 1));
  }
  for (const [mcc, rows] of byMcc) {
    const dest = path.join(cacheDir, `${Number(mcc)}.csv.gz`);
    if (existsSync(dest)) {
      console.error(
        `Refusing to overwrite existing ${dest} — delete it first.`,
      );
      continue;
    }
    console.log(`Writing ${rows.length} rows -> ${dest}`);
    await pipeline(
      Readable.from(rows.map((r) => `${r}\n`)),
      createGzip(),
      createWriteStream(dest),
    );
  }
}

await main();
