import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * Live Indian Railways proxy with a memory + disk cache.
 * Upstream: https://api.railradar.in/v1/legacy/trains/live-map
 *
 * Returns a single snapshot of every train currently running in India with a
 * live position ({current_lat,current_lng}) and its current/next station.
 * Pattern mirrors firmsProxy: TTL cache, single-flight refresh, serve-stale,
 * and a fresh-enough disk cache (.gev-cache/railways.json) prevents ANY
 * upstream fetch across dev-server restarts.
 *
 * The data key stays server-side: the client polls same-origin /api/railways
 * and never sees the bearer token. Keyless (no RAILRADAR_API_KEY): /api/railways
 * → 503 {error:'no_key'}; status → {hasKey:false}. Upstream is never touched
 * without a key.
 *
 * Routes:
 *   GET /api/railways        → {ok, status, fetchedAt, stale, ttlMs, count, trains}
 *   GET /api/railways/status → {hasKey, lastFetch, count, stale, ttlMs}
 *
 * @returns {import('vite').Plugin}
 */
export function railwaysProxy() {
  const TTL_MS = 10 * 60_000;
  const MAX_TRAINS = 5000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'railways.json');
  const UPSTREAM_URL = 'https://api.railradar.in/v1/legacy/trains/live-map';

  /** @type {?{at: number, trains: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, trains: Array<object>}>} single-flight refresh */
  let inflight = null;

  const apiKey = () => String(process.env.RAILRADAR_API_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.trains)) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[railways-proxy] cache write failed:', err?.message || err);
    }
  }

  async function refreshUpstream(key) {
    const res = await fetch(UPSTREAM_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const trains = normalizeRailwaySnapshot(await res.json(), MAX_TRAINS);
    return { at: Date.now(), trains };
  }

  function buildPayload(entry, stale) {
    return {
      ok: true,
      status: 'ok',
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      count: entry.trains.length,
      trains: entry.trains,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/railways', async (req, res) => {
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
        const key = apiKey();
        await readDiskOnce();

        if (subPath === '/status') {
          sendJson(200, {
            hasKey: Boolean(key),
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.trains.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
          });
          return;
        }

        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = mem;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight (concurrent requests
        // share one upstream pass). Capture the promise locally BEFORE
        // awaiting: the .finally() nulls `inflight` the moment it settles.
        if (!inflight) {
          inflight = refreshUpstream(key)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[railways-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const pending = inflight;
        const fresh = await pending;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'railways fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[railways-proxy] error:', err?.message || err);
        sendJson(500, { error: 'railways proxy error' });
      }
    });
  };
  return {
    name: 'railways-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

/**
 * Coerce a RailRadar live-map payload into canonical train rows. Tolerant of
 * the endpoint's documented snake_case fields and a couple of plausible
 * aliases, so snapshot reshuffles never break the browser layer. Rows without
 * a usable live position are dropped; midnight quiet periods legitimately
 * produce zero rows. Returns null only when the body is not a payload shape
 * at all (never a hard error for an empty-but-valid feed).
 * @param {unknown} payload - Upstream JSON body (object with `trains`/`data`,
 *   or a bare array).
 * @param {number} [max=5000] - Defensive cap on returned rows.
 * @returns {?Array<Object>}
 */
export function normalizeRailwaySnapshot(payload, max = 5000) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.trains)
      ? payload.trains
      : Array.isArray(payload?.data)
        ? payload.data
        : null;
  if (!rows) return null;
  const cap = Math.max(0, Math.min(5000, Math.floor(Number(max) || 0)));
  const seen = new Set();
  const trains = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const lat = toFiniteNumber(raw.current_lat ?? raw.latitude ?? raw.lat);
    const lng = toFiniteNumber(raw.current_lng ?? raw.longitude ?? raw.lng);
    if (
      lat === null ||
      lng === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      continue;
    const number = toText(raw.train_number ?? raw.train_no ?? raw.number);
    const name = toText(raw.train_name ?? raw.name);
    if (!number && !name) continue;
    const key = [number ?? '', name ?? ''].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    trains.push({
      number: number ?? `TRAIN-${trains.length + 1}`,
      name: name ?? number,
      type: toText(raw.type ?? raw.train_type) ?? 'OTH',
      lat,
      lng,
      currentStation: toText(raw.current_station ?? raw.station),
      currentStationName: toText(raw.current_station_name ?? raw.station_name),
      nextStation: toText(raw.next_station),
      nextStationName: toText(raw.next_station_name),
      minsSinceDep: toFiniteNumber(
        raw.mins_since_dep ?? raw.mins_since_departure,
      ),
    });
    if (trains.length >= cap) break;
  }
  return trains;
}
