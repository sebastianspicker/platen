import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlledRasterSession } from '../src/core/controlled-raster-session.js';
import {
  fileFromDrop,
  nextRotation,
  nextZoom,
  pageNumberFromNavigationTarget,
  requestElementFullscreen,
  transitionApplicationView,
} from '../src/core/ui-actions.js';

const documentId = '11111111-1111-4111-8111-111111111111';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pngBlob() {
  return new Blob([new Uint8Array(24)], { type: 'image/png' });
}

test('preview zoom steps and clamps without floating-point drift', () => {
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1.1, 1), 1.2);
  assert.equal(nextZoom(2, 1), 2);
  assert.equal(nextZoom(0.5, -1), 0.5);
  assert.throws(() => nextZoom(Number.NaN, 1), TypeError);
  assert.throws(() => nextZoom(1, 0), TypeError);
});

test('preview rotation advances through supported quarter turns', () => {
  assert.deepEqual([0, 90, 180, 270].map(nextRotation), [90, 180, 270, 0]);
  assert.throws(() => nextRotation(45), TypeError);
});

test('drop intake returns only the first supplied file', () => {
  const first = { name: 'first.pdf' };
  assert.equal(fileFromDrop({ dataTransfer: { files: [first, { name: 'second.pdf' }] } }), first);
  assert.equal(fileFromDrop({ dataTransfer: { files: [] } }), null);
  assert.equal(fileFromDrop(null), null);
});

test('fullscreen action calls the supplied surface and reports missing support', async () => {
  let calls = 0;
  await requestElementFullscreen({ requestFullscreen: async () => { calls += 1; } });
  assert.equal(calls, 1);
  await assert.rejects(() => requestElementFullscreen({}), /Fullscreen is unavailable/);
});

test('application view transitions revoke a ready editor-scoped loupe', async () => {
  const revoked = [];
  const session = new ControlledRasterSession({
    fetchPage: async () => pngBlob(),
    decodeBlob: async () => {},
    createObjectUrl: () => 'blob:loupe-ready',
    revokeObjectUrl: (url) => revoked.push(url),
  });
  await session.load(documentId, 1, { dpi: 240 });

  assert.equal(transitionApplicationView('editor', 'workflows', () => {
    session.reset('The application view changed.');
  }), 'workflows');
  assert.deepEqual(revoked, ['blob:loupe-ready']);
  assert.equal(session.current.status, 'idle');
});

test('application view transitions abort an in-flight loupe before it can publish', async () => {
  const pending = deferred();
  let signal;
  const session = new ControlledRasterSession({
    fetchPage: (_id, _page, _dpi, options) => {
      signal = options.signal;
      return pending.promise;
    },
    decodeBlob: async () => {},
    createObjectUrl: () => assert.fail('a view-stale loupe must not publish a URL'),
    revokeObjectUrl: () => {},
  });
  const loading = session.load(documentId, 1, { dpi: 240 });

  transitionApplicationView('editor', 'plugins', () => {
    session.reset('The application view changed.');
  });
  assert.equal(signal.aborted, true);
  pending.resolve(pngBlob());
  assert.equal(await loading, null);
  assert.equal(session.current.status, 'idle');
});

test('application view transition cleanup runs only when the view changes', () => {
  let cleanupCalls = 0;
  assert.equal(transitionApplicationView('editor', 'editor', () => { cleanupCalls += 1; }), 'editor');
  assert.equal(cleanupCalls, 0);
  assert.throws(() => transitionApplicationView('editor', 'unknown', () => {}), /Application views/);
  assert.throws(() => transitionApplicationView('editor', 'plugins'), /cleanup callback/);
});

test('trust is a first-class application view', () => {
  let cleanupCalls = 0;
  assert.equal(transitionApplicationView('plugins', 'trust', () => { cleanupCalls += 1; }), 'trust');
  assert.equal(cleanupCalls, 1);
});

test('navigation targets accept only canonical pages inside the inspected document', () => {
  assert.equal(pageNumberFromNavigationTarget({ dataset: { pageNumber: '2' } }, 3), 2);
  for (const pageNumber of ['', '0', '02', '-1', '2junk', '9007199254740992']) {
    assert.equal(pageNumberFromNavigationTarget({ dataset: { pageNumber } }, 3), null);
  }
  assert.equal(pageNumberFromNavigationTarget({ dataset: { pageNumber: '4' } }, 3), null);
  assert.equal(pageNumberFromNavigationTarget(null, 3), null);
  assert.equal(pageNumberFromNavigationTarget({ dataset: { pageNumber: '1' } }, 0), null);
});
