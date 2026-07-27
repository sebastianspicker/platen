import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { CommentsToOfficeService } from '../scripts/host/comments-to-office-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);
const artifactId = '22222222-2222-4222-8222-222222222222';

function annotation(id, page, text, replies = []) {
  return {
    id, prototypeSidecar: true, type: 'comment', page, rectangle: [1, 2, 3, 4], text,
    author: `reviewer-${id}`, status: page === 1 ? 'open' : 'resolved', properties: {}, mentions: [],
    createdAt: `2026-07-21T10:0${page}:00.000Z`, replies,
  };
}

async function setup({ verify = null, cleanup = null, promote = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'comments-to-office-'));
  let digest = sourceSha256;
  const calls = [];
  const documents = {
    getDocument(id) { assert.equal(id, documentId); return { id, sha256: digest, displayName: 'source.pdf' }; },
    async verifySource(id) { calls.push('verify'); assert.equal(id, documentId); await verify?.({ calls, setDigest: (value) => { digest = value; } }); },
    async createJobWorkspace() { const path = await mkdtemp(join(root, 'job-')); calls.push('workspace'); return path; },
    async cleanupJob(path) { calls.push('cleanup'); if (cleanup) return cleanup(path); return rm(path, { recursive: true, force: true }); },
    async promoteOoxmlArtifact(id, path, options) {
      calls.push('promote');
      if (promote) return promote({ id, path, options, calls });
      const bytes = await readFile(path);
      return { id: artifactId, documentId: id, displayName: options.displayName, mediaType: options.mediaType, size: bytes.length, sha256: options.expectedSha256, operation: options.operation };
    },
    async deleteArtifact(id) { calls.push(['delete', id]); },
  };
  const workspace = new WorkspaceStateStore((id) => id === documentId);
  workspace.createEntity(documentId, 'annotations', annotation('annotation-1', 1, 'First <review>', [
    { id: 'comment-1', text: 'Reply one', author: 'reviewer-reply', status: 'resolved', at: '2026-07-21T10:03:00.000Z' },
    { id: 'comment-2', text: 'Reply two', author: 'reviewer-reply', status: 'rejected', at: '2026-07-21T10:04:00.000Z' },
  ]));
  workspace.createEntity(documentId, 'annotations', annotation('annotation-2', 2, 'Second review'));
  return { root, calls, documents, workspace, service: new CommentsToOfficeService({ documents, workspace }) };
}

test('exports deterministic text-only DOCX records with exact provenance and no review parts', async (context) => {
  const state = await setup(); context.after(() => rm(state.root, { recursive: true, force: true }));
  let promotedBytes; let promotion;
  state.documents.promoteOoxmlArtifact = async (id, path, options) => {
    promotedBytes = Buffer.from(readFileSync(path)); promotion = options;
    return { id: artifactId, documentId: id, displayName: options.displayName, mediaType: options.mediaType, size: promotedBytes.length, sha256: options.expectedSha256, operation: options.operation };
  };
  const result = await state.service.export(documentId, { sourceSha256, revision: 2, selectedIds: null });
  assert.equal(result.kind, 'comments-to-office'); assert.equal(result.commentCount, 4); assert.equal(result.revision, 2);
  assert.equal(result.commentSha256, promotion.operation.parameters.commentSha256);
  assert.deepEqual({ ...promotion.operation.parameters }, { profile: 'local-comments-to-office-text-only-v1', revision: 2, commentSha256: result.commentSha256, commentCount: 4 });
  assert.equal(promotion.operation.type, 'comments-to-office');
  assert.deepEqual([...readZipEntries(promotedBytes).keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  const xml = readZipEntries(promotedBytes).get('word/document.xml').toString('utf8');
  assert.match(xml, /Page 1 \| Order 1 \| annotation annotation-1/);
  assert.match(xml, /Order 2 \| comment comment-1[^<]+Status resolved/);
  assert.match(xml, /Order 3 \| comment comment-2[^<]+Status rejected/);
  assert.match(xml, /Page 2 \| Order 4/);
  assert.match(xml, /First &lt;review&gt;/); assert.doesNotMatch(xml, /%PDF|comments\.xml|tracked comments/iu);
  assert.deepEqual(state.calls, ['verify', 'workspace', 'verify', 'verify', 'cleanup']);
});

test('selected IDs preserve current workspace order and reject forged or caller-supplied content', async (context) => {
  const state = await setup(); context.after(() => rm(state.root, { recursive: true, force: true }));
  let xml = '';
  state.documents.promoteOoxmlArtifact = async (id, path, options) => {
    const bytes = await readFile(path); xml = readZipEntries(bytes).get('word/document.xml').toString('utf8');
    return { id: artifactId, documentId: id, displayName: options.displayName, mediaType: options.mediaType, size: bytes.length, sha256: options.expectedSha256 };
  };
  const result = await state.service.export(documentId, { sourceSha256, revision: 2, selectedIds: ['annotation-2', 'comment-1'] });
  assert.equal(result.commentCount, 2); assert.ok(xml.indexOf('Order 2 | comment comment-1') < xml.indexOf('Order 4 | annotation annotation-2'));
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 2, selectedIds: ['forged'] }), { code: 'COMMENTS_TO_OFFICE_FORGED_ID', status: 409 });
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 2, selectedIds: ['comment-1', 'comment-1'] }), { code: 'COMMENTS_TO_OFFICE_FORGED_ID' });
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 2, selectedIds: null, text: 'caller injection' }), { code: 'INVALID_COMMENTS_TO_OFFICE_REQUEST' });
});

test('fails closed on revision drift, source drift, private payloads, emails, and raw authors', async (context) => {
  const state = await setup(); context.after(() => rm(state.root, { recursive: true, force: true }));
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 1, selectedIds: null }), { code: 'REVISION_CONFLICT', status: 409 });
  state.workspace.updateEntity(documentId, 'annotations', 'annotation-1', { ...annotation('annotation-1', 1, 'private@example.com') }, { expectedRevision: 2 });
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 3, selectedIds: null }), { code: 'COMMENTS_TO_OFFICE_PRIVATE_DATA' });
  state.workspace.updateEntity(documentId, 'annotations', 'annotation-1', { ...annotation('annotation-1', 1, 'safe'), author: 'Ada' }, { expectedRevision: 3 });
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 4, selectedIds: null }), { code: 'COMMENTS_TO_OFFICE_AUTHOR_NOT_PSEUDONYMOUS' });
  state.workspace.updateEntity(documentId, 'annotations', 'annotation-1', { ...annotation('annotation-1', 1, 'safe'), attachments: [{ id: 'file' }] }, { expectedRevision: 4 });
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 5, selectedIds: null }), { code: 'COMMENTS_TO_OFFICE_PRIVATE_DATA' });
  await assert.rejects(state.service.export(documentId, { sourceSha256: 'b'.repeat(64), revision: 5, selectedIds: null }), { code: 'SOURCE_VERSION_MISMATCH' });
});

test('cancellation after promotion revokes exactly the promoted artifact and releases the lease', async (context) => {
  const controller = new AbortController();
  const state = await setup({ promote: async ({ id, path, options }) => {
    const bytes = await readFile(path); controller.abort();
    return { id: artifactId, documentId: id, displayName: options.displayName, mediaType: options.mediaType, size: bytes.length, sha256: options.expectedSha256 };
  } });
  context.after(() => rm(state.root, { recursive: true, force: true }));
  await assert.rejects(state.service.export(documentId, { sourceSha256, revision: 2, selectedIds: null }, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(state.calls.at(-1), ['delete', artifactId]);
  assert.equal(state.workspace.createEntity(documentId, 'bookmarks', { id: 'released' }, { expectedRevision: 2 }).revision, 3);
});

test('source reverification prevents publication and cleanup failure revokes the artifact', async (context) => {
  let checks = 0;
  const drifting = await setup({ verify: async ({ setDigest }) => { checks += 1; if (checks === 2) setDigest('b'.repeat(64)); } });
  context.after(() => rm(drifting.root, { recursive: true, force: true }));
  await assert.rejects(drifting.service.export(documentId, { sourceSha256, revision: 2, selectedIds: null }), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.equal(drifting.calls.includes('promote'), false);

  const cleanupError = Object.assign(new Error('cleanup'), { code: 'CLEANUP_FAILED' });
  const failing = await setup({ cleanup: async () => { throw cleanupError; } });
  context.after(() => rm(failing.root, { recursive: true, force: true }));
  await assert.rejects(failing.service.export(documentId, { sourceSha256, revision: 2, selectedIds: null }), { code: 'OOXML_CLEANUP_FAILED' });
  assert.deepEqual(failing.calls.at(-1), ['delete', artifactId]);
});

test('real store promotion retains one source-bound DOCX without PDF bytes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'comments-to-office-store-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const source = await store.createDocument({ stream: Readable.from([Buffer.from('%PDF-1.7\nprivate source bytes')]), displayName: 'source.pdf' });
  const workspace = new WorkspaceStateStore(store);
  workspace.createEntity(source.id, 'annotations', annotation('annotation-1', 1, 'Store-bound review'));
  const result = await new CommentsToOfficeService({ documents: store, workspace }).export(source.id, { sourceSha256: source.sha256, revision: 1, selectedIds: null });
  const retained = store.getArtifact(result.artifact.id); const bytes = await readFile(retained.filePath);
  assert.equal(retained.operation.type, 'comments-to-office'); assert.equal(retained.operation.inputs[0].sha256, source.sha256);
  assert.equal(retained.operation.parameters.revision, 1); assert.equal(retained.operation.parameters.commentCount, 1);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), retained.sha256);
  assert.equal(bytes.includes(Buffer.from('%PDF')), false);
  await store.deleteArtifact(retained.id);
});
