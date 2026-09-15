/** Request and validate a complete /api/railways snapshot before it can replace displayed trains. */
export function createRailwaySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/railways', {
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
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`Railways HTTP ${response.status}`);
      }
      if (payload?.ok !== true || !Array.isArray(payload?.trains))
        throw new Error('Malformed railway snapshot');
      return payload;
    },
  };
}
