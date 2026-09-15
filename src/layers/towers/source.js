/** Request and validate a /api/towers bbox response before it can replace
 * displayed towers. The endpoint is keyless but requires a local OpenCelliD
 * CSV to exist on the server; when none is loaded the server answers 503
 * `{error:'no_data'}` and the layer shows the add-the-dump notice instead of
 * geometry (the same `keyRequired` signal, but no provider key is involved).
 */
export function createTowerSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal, bounds } = {}) {
      signal?.throwIfAborted();
      const query = bounds ? towerBoundsQuery(bounds) : '';
      const response = await fetchImpl(`/api/towers${query}`, {
        signal,
        cache: 'no-store',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_data')
          return { keyRequired: true };
        throw new Error(`Towers HTTP ${response.status}`);
      }
      if (payload?.ok !== true || !Array.isArray(payload?.towers))
        throw new Error('Malformed tower snapshot');
      return payload;
    },
  };
}

/**
 * Serialize a camera-view rectangle into bbox query parameters. `bounds` is
 * {north, south, east, west} in degrees — the shape the layer derives from the
 * camera and passes through unmodified, so no geographic maths live in the
 * source. Returns '' when the rectangle is unusable.
 * @param {{north: number, south: number, east: number, west: number}} bounds
 */
export function towerBoundsQuery(bounds) {
  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const east = Number(bounds?.east);
  const west = Number(bounds?.west);
  if (![north, south, east, west].every(Number.isFinite)) return '';
  const minLat = Math.max(-90, Math.min(north, south));
  const maxLat = Math.min(90, Math.max(north, south));
  if (maxLat - minLat <= 0) return '';
  const minLng = Math.max(-180, Math.min(east, west));
  const maxLng = Math.min(180, Math.max(east, west));
  if (maxLng - minLng <= 0) return '';
  const params = new URLSearchParams({
    neLat: maxLat,
    neLng: maxLng,
    swLat: minLat,
    swLng: minLng,
  });
  return `?${params.toString()}`;
}
