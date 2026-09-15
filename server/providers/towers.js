import path from 'node:path';
import {
  promises as fsp,
  createReadStream,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MCC_MNC_NETWORKS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./towers/mcc-mnc-networks.json', import.meta.url)),
    'utf8',
  ),
);

export const DEFAULT_TOWER_CAP = 250_000;
export const DEFAULT_GRID_DEGREES = 1;
export const DEFAULT_QUERY_LIMIT = 1000;
export const TOWER_MAX_QUERY_LIMIT = 20_000;

const openCellCacheDir = () =>
  path.join(
    process.env.OPENCELLID_CACHE_DIR || process.cwd(),
    '.gev-cache',
    'opencellid',
  );

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

/**
 * World cell-tower proxy backed by a local OpenCelliD dump.
 *
 * OpenCelliD publishes a world `cell_towers.csv.gz` (plus per-country slices;
 * free download with an API token) whose acquisition stays OUTSIDE the server:
 * the user places the file under `.gev-cache/opencellid/` (or points
 * `OPENCELLID_CSV_PATH` at it). The proxy then:
 *  1. Lazily streams the CSV on first request, keeping the globally MOST
 *     MEASURED towers up to `OPENCELLID_MAX_TOWERS` (a server-side cap — the
 *     raw world dump is far too large to hold fully in memory), and indexes
 *     them into a coarse lat/lon grid as it goes;
 *  2. Answers bounded snapshot queries (`/api/towers?neLat..&swLng..`) against
 *     that grid, most-measured first;
 *  3. Joins operator / brand / generations / bands from the bundled
 *     mcc-mnc.org networks table (`server/providers/towers/mcc-mnc-networks.json`).
 *
 * Keyless by design; same-origin only. With no data file, `/api/towers` falls
 * back to 503 `{error:'no_data'}` — the client renders the KEY REQUIRED-style
 * notice, and `/api/towers/status` reports what is missing.
 *
 * Routes:
 *   GET /api/towers?neLat&neLng&swLat&swLng[&limit] → {ok, status, count, towers}
 *   GET /api/towers/status                        → {hasData, file, rows, gridCells}
 *
 * @returns {import('vite').Plugin}
 */
export function towersProxy() {
  /** @type {?Promise<import('./towers/index.js').TowerIndex|null>} lazy build */
  let buildPromise = null;
  let built = null;

  async function ensureIndex() {
    if (built) return built;
    if (!buildPromise) {
      buildPromise = buildTowerIndexFromDisk({
        files: towerCandidates(),
        cap: towerCap(),
        gridDegrees: gridDegrees(),
        mccs: mccFilter(),
      })
        .then((result) => {
          built = result;
          if (!result) buildPromise = null;
          return result;
        })
        .catch((error) => {
          buildPromise = null;
          throw error;
        });
    }
    return buildPromise;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/towers', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        if (subPath === '/status') {
          const index = built || (await ensureIndex().catch(() => null));
          sendJson(200, {
            hasData: Boolean(index),
            file: index?.file || null,
            rows: index?.rows.length || 0,
            gridCells: index?.gridCells || 0,
            mccNetworks: Object.keys(MCC_MNC_NETWORKS).length,
            cap: towerCap(),
          });
          return;
        }
        const index = built || (await ensureIndex().catch(() => null));
        if (!index) {
          sendJson(503, { error: 'no_data' });
          return;
        }
        const rawQuery = String(req.url || '').split('?')[1] || '';
        const bounds = queryBounds(new URLSearchParams(rawQuery));
        if (!bounds) {
          sendJson(400, { error: 'invalid_bbox' });
          return;
        }
        const limit = queryLimit(new URLSearchParams(rawQuery));
        const towers = queryTowerIndex(index, bounds, limit).map((row) =>
          joinRow(index, row),
        );
        sendJson(200, {
          ok: true,
          status: 'ok',
          file: index.file,
          count: towers.length,
          towers,
        });
      } catch (error) {
        console.warn(`[towers-proxy] error: ${error?.message || error}`);
        sendJson(500, { error: 'towers proxy error' });
      }
    });
  };

  return {
    name: 'towers-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

// ── capability / env ────────────────────────────────────────────────────────

function towerCap() {
  const value = Number(process.env.OPENCELLID_MAX_TOWERS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TOWER_CAP;
}

function gridDegrees() {
  const value = Number(process.env.OPENCELLID_GRID_DEGREES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_GRID_DEGREES;
}

/** Empty set → keep every MCC. Otherwise only rows whose (numeric-normed, to
 * match the join contract) MCC is in the comma-separated list — e.g. `404,405`
 * to spend the whole bounded index on India. */
function mccFilter() {
  const raw = String(process.env.OPENCELLID_MCC_FILTER || '').trim();
  if (!raw) return null;
  const codes = new Set();
  for (const part of raw.split(',')) {
    const code = String(Number(String(part).trim()));
    if (code && code !== 'NaN') codes.add(code);
  }
  return codes.size ? codes : null;
}

/** Files to try, in precedence order: env override, then the world dump and
 * per-country dumps under `.gev-cache/opencellid/`, then a legacy bare file. */
export function towerCandidates() {
  const fromEnv = String(process.env.OPENCELLID_CSV_PATH || '').trim();
  const candidates = [];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(
    path.join(openCellCacheDir(), 'cell_towers.csv.gz'),
    path.join(openCellCacheDir(), 'cell_towers.csv'),
    ...listCsvDumpPaths(),
  );
  candidates.push(
    path.join(
      process.env.OPENCELLID_CACHE_DIR || process.cwd(),
      '.gev-cache',
      'opencellid.csv',
    ),
  );
  return candidates.filter(
    (file) => file && typeof file === 'string' && file.length > 0,
  );
}

/** Any `*.csv[.gz]` files the owner already dropped into the OpenCelliD cache
 * directory (per-country dumps, whatever naming), excluding the explicit world
 * dump names handled above. Best effort — directory listing failing yields []. */
function listCsvDumpPaths() {
  try {
    const names = readdirSync(openCellCacheDir());
    return names
      .filter((name) => /^.*\.csv(\.gz)?$/.test(name))
      .filter(
        (name) => name !== 'cell_towers.csv' && name !== 'cell_towers.csv.gz',
      )
      .sort()
      .map((name) => path.join(openCellCacheDir(), name));
  } catch {
    return [];
  }
}

// ── index build ─────────────────────────────────────────────────────────────

/**
 * Stream candidate OpenCelliD CSV files into a bounded lattice. Every readable,
 * non-empty file is merged into one index. Rows are kept id-unique and the
 * globally most-measured `cap` are retained (a bounded min-heap keyed on
 * `samples`, so the huge world dump is usable without full retention), which
 * also makes per-MCC dumps (e.g. several `NNN.csv.gz`) combine cleanly.
 * Returns `null` when no candidate yields rows.
 * @param {{files: string[], cap?: number, gridDegrees?: number, mccs?:
 *   Set<string>|null, readRows?: Function}} options - `readRows(file)` returns
 *   an async-iterable of lines. `mccs` (numeric-normed codes) keeps only rows
 *   whose MCC is listed; null keeps everything.
 * @returns {Promise<Object|null>} {file, rows, gridDegrees, gridCells, byCell}
 */
export async function buildTowerIndexFromDisk({
  files,
  cap = DEFAULT_TOWER_CAP,
  gridDegrees = DEFAULT_GRID_DEGREES,
  mccs = null,
  readRows = streamCsvRows,
} = {}) {
  const list = Array.isArray(files) ? files : [files];
  const heap = createHeap(cap);
  const used = [];
  for (const file of list) {
    if (typeof file === 'string') {
      try {
        await fsp.access(file);
      } catch {
        continue; // not present — next candidate
      }
    }
    const before = heap.size;
    try {
      for await (const line of readRows(file)) {
        const row = parseOpenCelliDRow(line);
        if (!row) continue;
        if (mccs && !mccs.has(String(Number(row.mcc)))) continue;
        heap.push(row); // internally dedupes by id
      }
      if (heap.size > before) used.push(file);
    } catch (error) {
      console.warn(
        `[towers-proxy] skipping ${readableFileLabel(file)}: ${
          error?.message || error
        }`,
      );
    }
  }
  const rows = heap.rows;
  if (rows.length === 0) return null;
  const byCell = {};
  let gridCells = 0;
  gridIndex(rows, gridDegrees, byCell, (count) => {
    gridCells = count;
  });
  return {
    file: mergedFileLabel(used),
    rows,
    gridDegrees,
    gridCells,
    byCell,
    joined: new Map(),
  };
}

function mergedFileLabel(used) {
  const names = used.map(readableFileLabel).filter(Boolean);
  if (names.length === 0) return '(none)';
  if (names.length === 1) return names[0];
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown}, +${names.length - 3} more` : shown;
}

function readableFileLabel(file) {
  if (typeof file !== 'string' || !file) return file?.label || '(stream)';
  return path.basename(file);
}

function resolveReadableFile(file) {
  return typeof file === 'object' && file?.stream ? file.stream : file;
}

function gridIndex(rows, gridDegrees, byCell, onCount) {
  const step = Math.max(Number.isFinite(gridDegrees) ? gridDegrees : 1, 1e-6);
  let cells = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const cellKey = `${Math.floor(row.lat / step)}:${Math.floor(row.lon / step)}`;
    let cell = byCell[cellKey];
    if (!cell) {
      cell = [];
      byCell[cellKey] = cell;
      cells += 1;
    }
    cell.push(i);
  }
  onCount?.(cells);
}

/**
 * Bounded min-heap over the most-measured towers, id-deduping as it goes.
 * Keeps at most `cap` rows, evicting the current lowest-`samples` row when
 * full — deterministic and order-independent, so a world dump yields the same
 * representative set regardless of file layout. Heap order is deliberately NOT
 * sorted; queries re-order their bounded slice.
 */
export function createHeap(cap) {
  const limit = Math.max(1, Math.floor(Number(cap) || 1));
  const data = [];
  const ids = new Set();
  const less = (a, b) => (a.samples ?? 0) < (b.samples ?? 0);

  function swap(i, j) {
    [data[i], data[j]] = [data[j], data[i]];
  }

  function siftUp(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!less(data[index], data[parent])) return;
      swap(index, parent);
      index = parent;
    }
  }

  function siftDown(index) {
    const size = data.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < size && less(data[left], data[smallest])) smallest = left;
      if (right < size && less(data[right], data[smallest])) smallest = right;
      if (smallest === index) return;
      swap(index, smallest);
      index = smallest;
    }
  }

  return {
    has(id) {
      return ids.has(id);
    },
    push(row) {
      if (ids.has(row.id)) return; // id-unique — ignore duplicates
      if (data.length < limit) {
        data.push(row);
        ids.add(row.id);
        siftUp(data.length - 1);
        return;
      }
      if (less(row, data[0])) return; // too weak to displace the worst keep
      ids.delete(data[0].id);
      data[0] = row;
      ids.add(row.id);
      siftDown(0);
    },
    get rows() {
      return data;
    },
    get size() {
      return data.length;
    },
  };
}

/**
 * Yield the lines of a CSV file (`...csv` or `...csv.gz`) as strings. `file`
 * may be a path or a `{stream: Readable}` descriptor (tests) whose bytes are
 * already de-gzipped.
 * @param {string|{stream: import('node:stream').Readable}} file
 */
export async function* streamCsvRows(file) {
  let stream;
  if (typeof file === 'object' && file?.stream) {
    stream = file.stream;
  } else {
    stream = createReadStream(file);
    if (String(file).endsWith('.gz')) {
      stream = stream.pipe(zlib.createGunzip());
    }
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

/**
 * Parse one OpenCelliD CSV line into a canonical tower row, or null when the
 * line is the header, blank, or cannot represent a tower. Column layout is the
 * fixed OpenCelliD export order:
 *   radio, mcc, mnc, lac, cellid, unit, lon, lat, range, samples, changeable,
 *   created, updated, averageSignal
 * @param {string} line
 */
export function parseOpenCelliDRow(line) {
  const text = toText(line);
  if (!text) return null;
  const columns = splitCsvLine(text);
  // The header row is the only line whose first column is textual "radio".
  if (!/^[A-Za-z]/.test(columns[0])) return null;
  if (columns.length < 14) return null;
  const radio = columns[0];
  const mcc = stripNumeric(columns[1], 3);
  const mnc = stripNumeric(columns[2], 4);
  const lac = stripNumeric(columns[3], 6);
  const cell = stripNumeric(columns[4], 8);
  if (!radio || !mcc || !mnc || !lac || !cell) return null;
  const lat = toFiniteNumber(columns[7]);
  const lon = toFiniteNumber(columns[6]);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: `${mcc}:${mnc}:${lac}:${cell}:${radio}`,
    radio,
    mcc,
    mnc,
    lac,
    cell,
    lat,
    lon,
    range: toFiniteNumber(columns[8]),
    samples: toFiniteNumber(columns[9]),
    averageSignal: toFiniteNumber(columns[13]),
  };
}

function stripNumeric(value, width = null) {
  const text = toText(value);
  if (!text || !/^[0-9]{1,8}$/.test(text)) return null;
  if (width && text.length > width) return null;
  return text;
}

function joinRow(index, row) {
  const cached = index.joined.get(row);
  if (cached) return cached;
  const network = mccNetworkFor(row.mcc, row.mnc);
  const joined = {
    ...row,
    operator: network?.operator || null,
    brand: network?.brand || null,
    networkTypes: network?.networkTypes || null,
    frequencyBands: network?.frequencyBands || null,
    generations: network?.generations || null,
    countryIso: network?.iso || null,
  };
  index.joined.set(row, joined);
  return joined;
}

/**
 * Resolve the bundled mcc-mnc.org entry for a numeric (zero-padding lost) pair.
 * The table key is `${Number(mcc)}:${Number(mnc)}` — both the dump and the
 * export drop leading zeros, so numeric normalization is the join contract.
 * @param {string} mcc
 * @param {string} mnc
 */
export function mccNetworkFor(mcc, mnc) {
  const key = `${Number(mcc)}:${String(Number(mnc))}`;
  return MCC_MNC_NETWORKS[key] || null;
}

// ── bbox query ──────────────────────────────────────────────────────────────

/**
 * Collect the tower rows inside a bounds rectangle from the grid index,
 * most-measured first, capped at `limit`.
 * @param {Object} index - as built by buildTowerIndexFromDisk
 * @param {{north:number,south:number,east:number,west:number}} bounds
 * @param {number} [limit]
 */
export function queryTowerIndex(index, bounds, limit = DEFAULT_QUERY_LIMIT) {
  if (!index?.byCell) return [];
  const cap = Math.max(
    0,
    Math.min(TOWER_MAX_QUERY_LIMIT, Math.floor(Number(limit) || 1)),
  );
  if (cap === 0) return [];
  const step = index.gridDegrees;
  const rows = index.rows;
  const result = [];
  for (const key of cellKeysInBounds(bounds, step)) {
    const cell = index.byCell[key];
    if (!cell) continue;
    for (const rowIndex of cell) {
      const row = rows[rowIndex];
      if (row.lat < bounds.south || row.lat > bounds.north) continue;
      if (row.lon < bounds.west || row.lon > bounds.east) continue;
      result.push(row);
    }
  }
  result.sort(
    (a, b) => (b.samples ?? 0) - (a.samples ?? 0) || a.id.localeCompare(b.id),
  );
  return result.slice(0, cap);
}

function cellKeysInBounds(bounds, step) {
  const keys = [];
  const minLat = Math.floor(bounds.south / step);
  const maxLat = Math.floor(bounds.north / step);
  const minLon = Math.floor(bounds.west / step);
  const maxLon = Math.floor(bounds.east / step);
  for (let lat = minLat; lat <= maxLat; lat += 1) {
    for (let lon = minLon; lon <= maxLon; lon += 1) {
      keys.push(`${lat}:${lon}`);
    }
  }
  return keys;
}

/** Parse and clamp bbox query params. Returns null when any part is unusable
 * or the rectangle has zero area. */
export function queryBounds(params) {
  const number = (key) => {
    const value = toFiniteNumber(params?.get?.(key));
    return value === null ? null : Math.max(-180, Math.min(180, value));
  };
  const north = number('neLat');
  const south = number('swLat');
  const east = number('neLng');
  const west = number('swLng');
  if (north === null || south === null || east === null || west === null)
    return null;
  const minLat = Math.max(-90, Math.min(north, south));
  const maxLat = Math.min(90, Math.max(north, south));
  const minLon = Math.max(-180, Math.min(east, west));
  const maxLon = Math.min(180, Math.max(east, west));
  if (maxLat <= minLat || maxLon <= minLon) return null;
  return { north: maxLat, south: minLat, east: maxLon, west: minLon };
}

function queryLimit(params) {
  const value = Number(params.get('limit'));
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_QUERY_LIMIT;
}

function splitCsvLine(text) {
  const columns = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      columns.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  columns.push(current);
  return columns;
}

export { MCC_MNC_NETWORKS };
