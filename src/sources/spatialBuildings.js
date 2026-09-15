import { LOAD_RADIUS_M } from '../spatial/buildings.js';

/** Read only a small neighborhood through the existing bounded/cache-aware proxy. */
export async function fetchSpatialBuildings(center, { signal } = {}) {
  const [lon, lat] = center || [];
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 85 ||
    Math.abs(lon) > 180
  )
    throw new Error('Choose a place below 85° latitude.');
  // Relation radius searches can dominate latency even in a tiny neighborhood.
  // The interactive layer explicitly reports way-only coverage; the parser also
  // understands complete relations supplied by a future indexed provider.
  const query = `[out:json][timeout:15];way["building"](around:${LOAD_RADIUS_M},${lat.toFixed(5)},${lon.toFixed(5)});out body geom;`;
  const response = await fetch('/api/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
    signal,
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Building source is busy. Try again shortly.'
        : 'Building source is unavailable. Your selection is safe; try again.',
    );
  const payload = await response.json();
  if (!Array.isArray(payload?.elements))
    throw new Error('Building source returned no usable geometry. Try again.');
  return payload;
}
