import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverpassAlprSource } from './source.js';
const box = { south: 30, west: -98, north: 30.1, east: -97.9 };
test('the source rejects invalid and unbounded queries before fetching', async () => {
  let calls = 0;
  const source = createOverpassAlprSource({
    fetchImpl() {
      calls++;
    },
  });
  for (const bad of [
    null,
    { ...box, west: '0);out;' },
    { ...box, north: 90 },
    { ...box, east: -99 },
    { ...box, south: NaN },
  ]) {
    await assert.rejects(source.fetch(bad), /bounded city viewport/);
  }
  assert.equal(calls, 0);
});
test('cancellation during body parsing rejects even when the transport ignores it', async () => {
  const abort = new AbortController();
  const source = createOverpassAlprSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      json: async () => {
        abort.abort();
        return { elements: [] };
      },
    }),
  });
  await assert.rejects(source.fetch(box, abort.signal), { name: 'AbortError' });
});
