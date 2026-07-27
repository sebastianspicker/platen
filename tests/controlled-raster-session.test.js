import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROLLED_RASTER_DPI, ControlledRasterSession } from '../src/core/controlled-raster-session.js';

const documentId = '11111111-1111-4111-8111-111111111111';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pngBlob(size = 24) {
  return new Blob([new Uint8Array(size)], { type: 'image/png' });
}

test('controlled raster session publishes one fixed local PNG and revokes it on reset', async () => {
  const calls = []; const changes = []; const decoded = []; const revoked = [];
  const session = new ControlledRasterSession({
    fetchPage: async (...args) => { calls.push(args); return pngBlob(); },
    decodeBlob: async (blob) => decoded.push(blob.size),
    createObjectUrl: () => 'blob:controlled-page-2',
    revokeObjectUrl: (url) => revoked.push(url),
    onChange: (value) => changes.push(value),
  });
  const result = await session.load(documentId, 2);
  assert.deepEqual(calls[0].slice(0, 3), [documentId, 2, CONTROLLED_RASTER_DPI]);
  assert(calls[0][3].signal instanceof AbortSignal);
  assert.deepEqual(decoded, [24]);
  assert.deepEqual(changes.map(({ status }) => status), ['loading', 'ready']);
  assert.deepEqual(result, { status: 'ready', page: 2, dpi: 192, url: 'blob:controlled-page-2', error: null });
  assert.equal(Object.isFrozen(result), true);
  session.reset();
  assert.deepEqual(revoked, ['blob:controlled-page-2']);
  assert.deepEqual(session.current, { status: 'idle', page: null, dpi: 192, url: null, error: null });
});

test('controlled raster session rejects stale page results and retains only the latest URL', async () => {
  const first = deferred(); const second = deferred(); const revoked = [];
  let call = 0;
  const session = new ControlledRasterSession({
    fetchPage: () => (++call === 1 ? first.promise : second.promise),
    decodeBlob: async () => {},
    createObjectUrl: (blob) => `blob:${blob.size}`,
    revokeObjectUrl: (url) => revoked.push(url),
  });
  const firstLoad = session.load(documentId, 1);
  const secondLoad = session.load(documentId, 2);
  first.resolve(pngBlob(25));
  second.resolve(pngBlob(26));
  const [staleResult, latestResult] = await Promise.all([firstLoad, secondLoad]);
  assert.equal(staleResult, null);
  assert.equal(latestResult, session.current);
  assert.deepEqual(session.current, { status: 'ready', page: 2, dpi: 192, url: 'blob:26', error: null });
  assert.deepEqual(revoked, []);
  session.reset();
  assert.deepEqual(revoked, ['blob:26']);
});

test('controlled raster session exposes bounded errors and rejects invalid authority', async () => {
  const session = new ControlledRasterSession({
    fetchPage: async () => { throw new Error('<renderer failed>'); },
    decodeBlob: async () => {},
    createObjectUrl: () => assert.fail('failed render must not create a URL'),
    revokeObjectUrl: () => {},
  });
  assert.deepEqual(await session.load(documentId, 1), {
    status: 'error', page: 1, dpi: 192, url: null, error: '<renderer failed>',
  });
  await assert.rejects(session.load('../escape', 1), /documentId/);
  await assert.rejects(session.load(documentId, 0), /page/);
  await assert.rejects(session.load(documentId, 1, { dpi: 241 }), /dpi/);
});

test('controlled raster session validates decoding before publishing a retained URL', async () => {
  const session = new ControlledRasterSession({
    fetchPage: async () => pngBlob(),
    decodeBlob: async () => { throw new Error('Unreadable PNG payload.'); },
    createObjectUrl: () => assert.fail('undecodable render must not create the retained URL'),
    revokeObjectUrl: () => {},
  });
  assert.deepEqual(await session.load(documentId, 1), {
    status: 'error', page: 1, dpi: 192, url: null, error: 'Unreadable PNG payload.',
  });
});

test('controlled raster session revokes replaced URLs and reset aborts outstanding work', async () => {
  const pending = deferred(); const signals = []; const revoked = [];
  let call = 0;
  const session = new ControlledRasterSession({
    fetchPage: (_documentId, _page, _dpi, { signal }) => {
      signals.push(signal);
      call += 1;
      return call < 3 ? Promise.resolve(pngBlob(23 + call)) : pending.promise;
    },
    decodeBlob: async () => {},
    createObjectUrl: (blob) => `blob:${blob.size}`,
    revokeObjectUrl: (url) => revoked.push(url),
  });
  await session.load(documentId, 1);
  await session.load(documentId, 2);
  assert.deepEqual(revoked, ['blob:24']);
  const outstanding = session.load(documentId, 3);
  assert.deepEqual(revoked, ['blob:24', 'blob:25']);
  session.reset();
  assert.equal(signals.at(-1).aborted, true);
  pending.resolve(pngBlob(26));
  assert.equal(await outstanding, null);
  assert.equal(session.current.status, 'idle');
});

test('a dedicated loupe session retains one fixed-DPI snapshot URL and revokes it on context reset', async () => {
  const calls = []; const revoked = [];
  const region = Object.freeze({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  const session = new ControlledRasterSession({
    fetchPage: async (id, page, dpi, options) => {
      calls.push({ id, page, dpi, region, signal: options.signal });
      return pngBlob(32);
    },
    decodeBlob: async () => {},
    createObjectUrl: () => 'blob:loupe-region',
    revokeObjectUrl: (url) => revoked.push(url),
  });
  assert.deepEqual(await session.load(documentId, 3, { dpi: 240 }), {
    status: 'ready', page: 3, dpi: 240, url: 'blob:loupe-region', error: null,
  });
  assert.deepEqual(calls.map(({ id, page, dpi }) => ({ id, page, dpi })), [{ id: documentId, page: 3, dpi: 240 }]);
  assert(calls[0].signal instanceof AbortSignal);
  session.reset('Page context changed.');
  assert.deepEqual(revoked, ['blob:loupe-region']);
  assert.equal(session.current.status, 'idle');
});
