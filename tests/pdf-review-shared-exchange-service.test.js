import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewSharedExchangeManifest, reviewSharedExchangeDigest } from '../scripts/host/pdf-review-shared-exchange-contract.mjs';
import { PdfReviewSharedExchangeService } from '../scripts/host/pdf-review-shared-exchange-service.mjs';
import { canonicalizeProjectBundle } from '../scripts/host/project-bundle-framing.mjs';
import { crc32, readZipEntries } from '../scripts/host/zip-reader.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);

function setup() {
  const documents = {
    getDocument(id) {
      if (id !== documentId) throw Object.assign(new Error('missing document'), { code: 'DOCUMENT_NOT_FOUND' });
      return { id, sha256: sourceSha256 };
    },
    async verifySource(id) {
      if (id !== documentId) throw Object.assign(new Error('missing document'), { code: 'DOCUMENT_NOT_FOUND' });
      return true;
    },
  };
  const workspace = new WorkspaceStateStore((id) => id === documentId);
  return { documents, workspace, service: new PdfReviewSharedExchangeService({ documents, workspace }) };
}

function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30);
    locals.push(Buffer.concat([local, data]));
    const row = Buffer.alloc(46); row.writeUInt32LE(0x02014b50, 0); row.writeUInt16LE(20, 4); row.writeUInt16LE(20, 6);
    row.writeUInt32LE(crc32(data), 16); row.writeUInt32LE(data.length, 20); row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(nameBytes.length, 28); row.writeUInt32LE(offset, 42); central.push(Buffer.concat([row, nameBytes]));
    offset += locals.at(-1).length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function packageWithDeltas(deltas, baseRevision = 0) {
  const manifest = createReviewSharedExchangeManifest({ sourceSha256, baseRevision, reviewerId: 'reviewer-local', deltas });
  return storedZip([
    ['manifest.json', Buffer.from(canonicalizeProjectBundle(manifest))],
    ['deltas.json', Buffer.from(canonicalizeProjectBundle({ schemaVersion: 1, deltas }))],
  ]);
}

function annotation() {
  return {
    id: 'annotation-1', prototypeSidecar: true, type: 'highlight', page: 1,
    rectangle: { x: 1, y: 2, width: 30, height: 10 }, text: 'Review this', author: 'reviewer-local',
    status: 'open', customStatus: null, properties: {}, mentions: [], createdAt: '2026-07-21T10:00:00.000Z', replies: [],
  };
}

test('shared review export omits source bytes and imports atomically with idempotent replay', async () => {
  const first = setup();
  first.workspace.createEntity(documentId, 'annotations', annotation());
  const exported = await first.service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 0 });
  assert.equal(exported.bytes.includes(Buffer.from('%PDF')), false);
  assert.deepEqual([...readZipEntries(exported.bytes).keys()].sort(), ['deltas.json', 'manifest.json']);

  const second = setup();
  const imported = await second.service.import(documentId, exported.bytes);
  assert.equal(imported.applied, 1);
  assert.equal(imported.idempotent, false);
  assert.equal(second.workspace.snapshot(documentId).namespaces.annotations[0].author, 'reviewer-local');
  const replay = await second.service.import(documentId, exported.bytes);
  assert.equal(replay.idempotent, true);
  assert.equal(second.workspace.snapshot(documentId).revision, imported.revision);
});

test('shared review import rejects stale revisions, duplicate IDs, tampering, and unsafe archives without mutation', async () => {
  const source = setup();
  source.workspace.createEntity(documentId, 'annotations', annotation());
  const exported = await source.service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 0 });
  const target = setup();
  target.workspace.createEntity(documentId, 'bookmarks', { id: 'existing' });
  const before = target.workspace.snapshot(documentId);
  await assert.rejects(target.service.import(documentId, exported.bytes), { code: 'REVIEW_SHARED_EXCHANGE_REVISION_CONFLICT', status: 409 });
  assert.deepEqual(target.workspace.snapshot(documentId), before);

  const authorConflict = setup();
  authorConflict.workspace.createEntity(documentId, 'annotations', { ...annotation(), author: 'reviewer-other' });
  const conflictBefore = authorConflict.workspace.snapshot(documentId);
  await assert.rejects(authorConflict.service.import(documentId, exported.bytes), { code: 'REVIEW_SHARED_EXCHANGE_CONFLICT', status: 409 });
  assert.deepEqual(authorConflict.workspace.snapshot(documentId), conflictBefore);

  const deltas = [...readZipEntries(exported.bytes).values()].find((bytes) => bytes.includes(Buffer.from('annotation-1')));
  assert.ok(deltas);
  const parsed = JSON.parse(readZipEntries(exported.bytes).get('deltas.json').toString('utf8'));
  const duplicate = packageWithDeltas([...parsed.deltas, parsed.deltas[0]]);
  await assert.rejects(setup().service.import(documentId, duplicate), { code: 'REVIEW_SHARED_EXCHANGE_DUPLICATE_ID', status: 409 });

  const tampered = Buffer.from(exported.bytes); tampered[tampered.length - 30] ^= 1;
  await assert.rejects(setup().service.import(documentId, tampered), { code: 'REVIEW_SHARED_EXCHANGE_INVALID_ARCHIVE' });
  await assert.rejects(setup().service.import(documentId, Buffer.from('not a zip')), { code: 'INVALID_ARCHIVE' });
  const unsafe = storedZip([['../manifest.json', Buffer.from('{}')], ['deltas.json', Buffer.from('{}')]]);
  await assert.rejects(setup().service.import(documentId, unsafe), { code: 'INVALID_ARCHIVE_PATH' });
});

test('shared review export rejects attachments and cancellation before mutation', async () => {
  const { service, workspace } = setup();
  workspace.createEntity(documentId, 'annotations', { ...annotation(), attachments: [{ id: 'file' }] });
  await assert.rejects(service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 0 }), { code: 'REVIEW_SHARED_EXCHANGE_UNSUPPORTED_ANNOTATION' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 1 }, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(service.import(documentId, Buffer.from('x'), { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(service.import(documentId, Buffer.from('x'), { signal: {} }), TypeError);
});

test('simultaneous replay is deterministic and applies at most one workspace revision', async () => {
  const source = setup();
  source.workspace.createEntity(documentId, 'annotations', annotation());
  const exported = await source.service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 0 });
  const target = setup();
  const results = await Promise.all([target.service.import(documentId, exported.bytes), target.service.import(documentId, exported.bytes)]);
  assert.deepEqual(results.map((result) => result.applied), [1, 0]);
  assert.equal(target.workspace.snapshot(documentId).revision, 1);
  assert.equal(target.workspace.snapshot(documentId).namespaces.annotations.length, 1);
});

test('source verification catches drift before publication and import apply', async () => {
  const source = setup();
  source.workspace.createEntity(documentId, 'annotations', annotation());
  const stable = await source.service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 0 });
  let digest = sourceSha256; let checks = 0;
  const driftingDocuments = {
    getDocument: (id) => ({ id, sha256: digest }),
    verifySource: async () => { checks += 1; if (checks === 1) digest = 'b'.repeat(64); },
  };
  const drifting = new PdfReviewSharedExchangeService({ documents: driftingDocuments, workspace: source.workspace });
  await assert.rejects(drifting.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 1 }), { code: 'REVIEW_SHARED_EXCHANGE_SOURCE_MISMATCH', status: 409 });
  const before = source.workspace.snapshot(documentId);
  await assert.rejects(drifting.import(documentId, stable.bytes), { code: 'REVIEW_SHARED_EXCHANGE_SOURCE_MISMATCH', status: 409 });
  assert.deepEqual(source.workspace.snapshot(documentId), before);
});

test('import snapshots package bytes before an asynchronous verifier can mutate the caller buffer', async () => {
  const source = setup();
  source.workspace.createEntity(documentId, 'annotations', annotation());
  const stable = await source.service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 0 });
  const input = Buffer.from(stable.bytes);
  const documents = {
    getDocument: (id) => ({ id, sha256: sourceSha256 }),
    verifySource: async () => { input[0] ^= 0xff; },
  };
  const target = new PdfReviewSharedExchangeService({ documents, workspace: setup().workspace });
  const result = await target.import(documentId, input);
  assert.equal(result.applied, 1);
});

test('optimistic replay does not treat a same-ID comment under another annotation as idempotent', async () => {
  const source = setup();
  source.workspace.createEntity(documentId, 'annotations', { ...annotation(), replies: [{ id: 'comment-1', text: 'reply', author: 'reviewer-local', at: '2026-07-21T10:01:00.000Z' }] });
  const exported = await source.service.export(documentId, { reviewerId: 'reviewer-local', baseRevision: 1 });
  const target = setup();
  target.workspace.createEntity(documentId, 'annotations', { ...annotation(), id: 'annotation-other', replies: [{ id: 'comment-1', text: 'reply', author: 'reviewer-local', at: '2026-07-21T10:01:00.000Z' }] });
  const actualReplace = target.workspace.replaceSnapshot.bind(target.workspace);
  target.workspace.replaceSnapshot = () => { throw Object.assign(new Error('race'), { code: 'REVISION_CONFLICT', status: 409 }); };
  await assert.rejects(target.service.import(documentId, exported.bytes), { code: 'REVISION_CONFLICT', status: 409 });
  target.workspace.replaceSnapshot = actualReplace;
});
