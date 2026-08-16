import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleComparisonBatchRoute,
  handleComparisonRoute,
} from '../scripts/host/routes/workflow-mutation-routes.mjs';

const primaryId = '11111111-1111-4111-8111-111111111111';
const secondaryId = '22222222-2222-4222-8222-222222222222';
const thirdId = '33333333-3333-4333-8333-333333333333';

function routeContext(body, comparisons, pathname = `/api/documents/${primaryId}/compare`, search = '') {
  const writes = [];
  const request = { method: 'POST', url: `${pathname}${search}` };
  return {
    context: {
      request,
      response: {},
      url: new URL(`http://local${pathname}${search}`),
      pathname,
      documentId: primaryId,
      processing: { signal: 'signal' },
      comparisons,
      method(value, expected) { assert.equal(value, request); assert.equal(expected, 'POST'); },
      readJson() { return body; },
      json(_response, status, value) { writes.push({ status, value }); },
    },
    writes,
  };
}

function comparisonStub(calls) {
  return Object.fromEntries([
    ['compareContent', async (...args) => { calls.push(['content', args]); return { kind: 'content' }; }],
    ['comparePixels', async (...args) => { calls.push(['pixel', args]); return { kind: 'pixel' }; }],
    ['compareCrossFormat', async (...args) => { calls.push(['cross-format', args]); return { kind: 'cross-format' }; }],
    ['describeOverlay', async (...args) => { calls.push(['overlay', args]); return { kind: 'overlay' }; }],
    ['describeSideBySide', async (...args) => { calls.push(['side-by-side', args]); return { kind: 'side-by-side' }; }],
    ['compareAnnotations', async (...args) => { calls.push(['annotations', args]); return { kind: 'annotations' }; }],
    ['compareBatch', async (...args) => { calls.push(['batch', args]); return { kind: 'batch' }; }],
  ]);
}

test('comparison routes forward only the exact bounded local request', async () => {
  const calls = [];
  const comparisons = comparisonStub(calls);
  const modes = [
    ['content', {}],
    ['annotations', {}],
    ['cross-format', {}],
    ['pixel', { pages: [1, 200], dpi: 240 }],
    ['overlay', { page: 2, opacity: 0.5 }],
    ['side-by-side', { page: 3 }],
  ];
  for (const [mode, options] of modes) {
    const fixture = routeContext({ secondaryDocumentId: secondaryId, mode, options }, comparisons);
    await handleComparisonRoute(fixture.context);
    assert.deepEqual(fixture.writes, [{ status: 200, value: { report: { kind: mode } } }]);
  }
  assert.deepEqual(calls.slice(0, 6).map(([mode, args]) => [mode, args[0], args[1], args[2].signal]), modes.map(([mode]) => [mode, primaryId, secondaryId, 'signal']));
  assert.deepEqual(calls[3][1][2].pages, [1, 200]);

  const batchCalls = [];
  const batch = routeContext({
    pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: secondaryId, pages: [1], dpi: 36 }],
    mode: 'pixel',
  }, comparisonStub(batchCalls), '/api/comparisons/batch');
  assert.equal(await handleComparisonBatchRoute(batch.context), true);
  assert.deepEqual(batchCalls[0], ['batch', [[{ primaryDocumentId: primaryId, secondaryDocumentId: secondaryId, pages: [1], dpi: 36 }], { mode: 'pixel', signal: 'signal' }]]);
});

test('comparison routes reject malformed, extra, accessor, proxy, query, and unsupported requests', async () => {
  const calls = [];
  const comparisons = comparisonStub(calls);
  const directInvalid = [
    { secondaryDocumentId: secondaryId, mode: 'content', options: {}, extra: true },
    { secondaryDocumentId: 'secondary', mode: 'content', options: {} },
    { secondaryDocumentId: primaryId, mode: 'content', options: {} },
    { secondaryDocumentId: secondaryId, mode: 'remote', options: {} },
    { secondaryDocumentId: secondaryId, mode: 'content', options: { unsafe: true } },
    { secondaryDocumentId: secondaryId, mode: 'content', options: { signal: 'forged' } },
    { secondaryDocumentId: secondaryId, mode: 'toString', options: {} },
    { secondaryDocumentId: secondaryId, mode: 'constructor', options: {} },
    { secondaryDocumentId: secondaryId, mode: '__proto__', options: {} },
    { secondaryDocumentId: secondaryId, mode: 'pixel', options: { pages: [1, 1] } },
    { secondaryDocumentId: secondaryId, mode: 'pixel', options: { pages: [0] } },
    { secondaryDocumentId: secondaryId, mode: 'pixel', options: { pages: [201] } },
    { secondaryDocumentId: secondaryId, mode: 'pixel', options: { dpi: 35 } },
    { secondaryDocumentId: secondaryId, mode: 'overlay', options: { opacity: 0 } },
    { secondaryDocumentId: secondaryId, mode: 'overlay', options: { opacity: 1 } },
    { secondaryDocumentId: secondaryId, mode: 'side-by-side', options: { page: 201 } },
  ];
  for (const body of directInvalid) {
    const fixture = routeContext(body, comparisons);
    await assert.rejects(handleComparisonRoute(fixture.context), { status: 400 });
  }
  const accessor = { secondaryDocumentId: secondaryId, mode: 'content', options: {} };
  Object.defineProperty(accessor, 'mode', { enumerable: true, get() { throw new Error('getter must not run'); } });
  await assert.rejects(handleComparisonRoute(routeContext(accessor, comparisons).context), { code: 'INVALID_COMPARISON' });
  const proxied = new Proxy({ secondaryDocumentId: secondaryId, mode: 'content', options: {} }, { ownKeys() { throw new Error('proxy trap must not run'); } });
  await assert.rejects(handleComparisonRoute(routeContext(proxied, comparisons).context), { code: 'INVALID_COMPARISON' });
  await assert.rejects(handleComparisonRoute(routeContext({ secondaryDocumentId: secondaryId, mode: 'content', options: {} }, comparisons, undefined, '?unsafe=1').context), { code: 'INVALID_PARAMETER' });

  const batchInvalid = [
    { pairs: [], mode: 'content' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: secondaryId }], mode: 'remote' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: secondaryId, extra: true }], mode: 'content' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: primaryId }], mode: 'content' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: secondaryId, pages: [1] }], mode: 'content' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: thirdId, pages: [1, 1] }], mode: 'pixel' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: thirdId, dpi: 241 }], mode: 'pixel' },
    { pairs: Array.from({ length: 9 }, () => ({ primaryDocumentId: primaryId, secondaryDocumentId: thirdId })), mode: 'content' },
    { pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: thirdId }], mode: 'content', extra: true },
  ];
  for (const body of batchInvalid) {
    const fixture = routeContext(body, comparisons, '/api/comparisons/batch');
    await assert.rejects(handleComparisonBatchRoute(fixture.context), { status: 400 });
  }
  await assert.rejects(handleComparisonBatchRoute(routeContext({ pairs: [{ primaryDocumentId: primaryId, secondaryDocumentId: thirdId }], mode: 'content' }, comparisons, '/api/comparisons/batch', '?unsafe=1').context), { code: 'INVALID_PARAMETER' });
  assert.equal(calls.length, 0);
});
