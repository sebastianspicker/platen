import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyPngToClipboard,
  MAX_SNAPSHOT_BLOB_BYTES,
  normalizeSnapshotRegion,
  prepareSnapshotPng,
} from '../src/core/snapshot-output.js';

test('snapshot region accepts only a bounded six-decimal normalized rectangle', () => {
  assert.deepEqual(normalizeSnapshotRegion({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), {
    x: 0.1, y: 0.2, width: 0.3, height: 0.4,
  });
  for (const region of [
    { x: 0, y: 0, width: 1, height: 1, extra: true },
    { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    { x: 0.8, y: 0, width: 0.3, height: 0.5 },
    { x: 0, y: 0.8, width: 0.5, height: 0.3 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 0.1234567, height: 1 },
    { x: '0', y: 0, width: 1, height: 1 },
  ]) assert.throws(() => normalizeSnapshotRegion(region), TypeError);
});

test('PNG clipboard output writes one exact image item and rejects unavailable or unsafe output', async () => {
  const writes = [];
  class FakeClipboardItem {
    constructor(items) { this.items = items; }
  }
  const blob = new Blob(['png'], { type: 'image/png' });
  const receipt = await copyPngToClipboard(blob, {
    clipboard: { write: async (items) => { writes.push(items); } },
    ClipboardItemCtor: FakeClipboardItem,
  });
  assert.deepEqual(receipt, { copied: true, mediaType: 'image/png', size: 3 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 1);
  assert.equal(await writes[0][0].items['image/png'], blob);

  let resolveBlob;
  let writeStarted = false;
  const delayed = new Promise((resolve) => { resolveBlob = resolve; });
  const pendingCopy = copyPngToClipboard(delayed, {
    clipboard: { write: async (items) => {
      writeStarted = true;
      resolveBlob(blob);
      assert.equal(await items[0].items['image/png'], blob);
    } },
    ClipboardItemCtor: FakeClipboardItem,
  });
  assert.equal(writeStarted, true, 'clipboard.write is called before the asynchronous PNG resolves');
  await pendingCopy;

  await assert.rejects(copyPngToClipboard(blob, { clipboard: null, ClipboardItemCtor: null }), /unavailable/i);
  await assert.rejects(copyPngToClipboard(new Blob(['pdf'], { type: 'application/pdf' }), {
    clipboard: { write: async () => {} }, ClipboardItemCtor: FakeClipboardItem,
  }), TypeError);
  await assert.rejects(copyPngToClipboard(new Blob([], { type: 'image/png' }), {
    clipboard: { write: async () => {} }, ClipboardItemCtor: FakeClipboardItem,
  }), TypeError);
  const oversized = { type: 'image/png', size: MAX_SNAPSHOT_BLOB_BYTES + 1 };
  await assert.rejects(copyPngToClipboard(oversized, {
    clipboard: { write: async () => {} }, ClipboardItemCtor: FakeClipboardItem,
  }), TypeError);
});

test('snapshot preparation rejects page-stale output before and after browser decoding', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  let page = 1;
  let resolveBlob;
  let decoded = 0;
  const delayed = new Promise((resolve) => { resolveBlob = resolve; });
  const beforeDecode = prepareSnapshotPng(delayed, {
    isCurrent: () => page === 1,
    decodeBlob: async () => { decoded += 1; },
  });
  page = 2;
  resolveBlob(blob);
  await assert.rejects(beforeDecode, { code: 'SNAPSHOT_STALE' });
  assert.equal(decoded, 0);

  page = 1;
  const afterDecode = prepareSnapshotPng(blob, {
    isCurrent: () => page === 1,
    decodeBlob: async () => { decoded += 1; page = 2; },
  });
  await assert.rejects(afterDecode, { code: 'SNAPSHOT_STALE' });
  assert.equal(decoded, 1);
});

test('page-stale promised PNG never fulfills the clipboard item', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  let page = 1;
  let resolveBlob;
  let fulfilled = false;
  const raw = new Promise((resolve) => { resolveBlob = resolve; });
  const prepared = prepareSnapshotPng(raw, { isCurrent: () => page === 1, decodeBlob: async () => {} });
  class FakeClipboardItem { constructor(items) { this.items = items; } }
  const copying = copyPngToClipboard(prepared, {
    ClipboardItemCtor: FakeClipboardItem,
    clipboard: { write: async ([item]) => {
      await item.items['image/png'];
      fulfilled = true;
    } },
  });
  page = 2;
  resolveBlob(blob);
  await assert.rejects(copying, { code: 'SNAPSHOT_STALE' });
  assert.equal(fulfilled, false);
});
