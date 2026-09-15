/**
 * Download the OpenCelliD cell-tower dump for the Cell Towers layer.
 *
 * OpenCelliD requires a free account/token for downloads, which only a real
 * email human can create — this script only automates the download itself:
 *
 *   1. Register (free) at https://opencellid.org and reveal your API token.
 *   2. Run:   OPENCELLID_TOKEN=pk.xxxx node scripts/fetch-opencellid.mjs
 *
 * Saves the WORLD dump to .gev-cache/opencellid/cell_towers.csv.gz (the path
 * the dev-server proxy reads on first /api/towers request). India (MCC 404,
 * 405) is NOT in any current export — per-country or world — pending clarity
 * on India's geospatial policy (OpenCelliD staff, 2024), so the world file is
 * NOT a way to get Indian towers. For India use scripts/harvest-opencellid-api.mjs
 * (API harvest into 404.csv.gz/405.csv.gz) optionally over a 2017 archive.org
 * baseline (CC-BY-SA) filtered to MCC 404/405.
 *
 * Each token allows 2 downloads per file per day; the world dump is large
 * (streams over some minutes). Use --mcc=404 to grab a single published MCC
 * slice instead. A failing request never overwrites an existing dump.
 */
import { createWriteStream, existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cacheDir = path.join(root, '.gev-cache', 'opencellid');

const token = String(process.env.OPENCELLID_TOKEN || '').trim();
const mccArg = process.argv
  .filter((arg) => arg.startsWith('--mcc='))
  .map((arg) => arg.split('=')[1].trim())
  .at(0);

if (!/^pk\./.test(token)) {
  console.error(
    'Missing OpenCelliD token. Create a free account at https://opencellid.org,',
    'reveal your API token, then run with OPENCELLID_TOKEN=pk.yourtoken.',
    'A token is only used here for the one-time download — the app never needs it.',
  );
  process.exit(1);
}

const filename = mccArg ? `${mccArg}.csv.gz` : 'cell_towers.csv.gz';
const params = new URLSearchParams({
  token,
  file: filename,
  type: mccArg ? 'mcc' : 'full',
});
const url = `https://opencellid.org/ocid/downloads?${params}`;
const destination = path.join(cacheDir, filename);

// Never leave a truncated/error body over a known-good dump.
if (existsSync(destination)) {
  console.error(`Refusing to overwrite existing ${destination} — delete it first to redownload.`);
  process.exit(1);
}

await fsp.mkdir(cacheDir, { recursive: true });
console.log(`Fetching ${url.replace(token, 'pk.****')}`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) {
  const body = await response.text();
  console.error(`OpenCelliD download failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
  console.error('Note: each token allows 2 downloads per file per day.');
  process.exit(1);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
const size = (await fsp.stat(destination)).size;
console.log(`Saved ${destination} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log(
  mccArg
    ? 'Restart the dev server — the layer then builds its tower index on first query.'
    : 'Restart the dev server. To keep only Indian towers, also set\n  OPENCELLID_MCC_FILTER=404,405\nin .env so the bounded index is spent on India, not the whole world.',
);