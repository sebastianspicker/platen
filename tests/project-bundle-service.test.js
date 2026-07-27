import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import {
  ProjectBundleService,
  PROJECT_BUNDLE_MAX_BYTES,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  canonicalizeProjectBundle,
} from '../scripts/host/project-bundle-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const firstDocument = '11111111-1111-4111-8111-111111111111';
const secondDocument = '22222222-2222-4222-8222-222222222222';
const otherDocument = '33333333-3333-4333-8333-333333333333';
const sharedDigest = 'a'.repeat(64);

function setup() {
  const digests = new Map([[firstDocument, sharedDigest], [secondDocument, sharedDigest], [otherDocument, 'b'.repeat(64)]]);
  const documents = { getDocument: (id) => {
    const sha256 = digests.get(id);
    if (!sha256) throw new Error('missing document');
    return Object.freeze({ id, sha256 });
  } };
  const workspace = new WorkspaceStateStore((id) => digests.has(id));
  return { workspace, service: new ProjectBundleService(documents, workspace) };
}

test('project bundles are canonical, digest-bound, and omit session document IDs', () => {
  const { workspace, service } = setup();
  workspace.createEntity(firstDocument, 'annotations', { id: 'note-1', text: 'Local review' });
  const first = service.exportBundle(firstDocument);
  const second = service.exportBundle(firstDocument);
  assert.equal(first, second);
  assert.equal(first.includes(firstDocument), false);
  const bundle = JSON.parse(first);
  assert.deepEqual(Object.keys(bundle).sort(), ['payloadSha256', 'schemaVersion', 'sourcePdfSha256', 'workspace']);
  assert.equal(bundle.sourcePdfSha256, sharedDigest);
});

test('project bundle import rebinds workspace to another local document with the same digest', () => {
  const { workspace, service } = setup();
  workspace.createEntity(firstDocument, 'bookmarks', { id: 'bookmark-1', label: 'Page one' });
  const imported = service.importBundle(secondDocument, service.exportBundle(firstDocument), { expectedRevision: 0 });
  assert.equal(imported.documentId, secondDocument);
  assert.equal(imported.namespaces.bookmarks[0].label, 'Page one');
  assert.equal(imported.revision, 1);
  assert.equal(Object.isFrozen(imported), true);
  assert.throws(() => imported.namespaces.bookmarks.push({ id: 'nope' }), TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(imported)), imported);
});

test('project bundle rejects tampering, wrong source digests, extra keys, oversize input, and revision conflicts', () => {
  const { workspace, service } = setup();
  workspace.createEntity(firstDocument, 'annotations', { id: 'note-1', text: 'review' });
  const exported = service.exportBundle(firstDocument);
  const tampered = JSON.parse(exported); tampered.workspace.namespaces.annotations[0].text = 'changed';
  assert.throws(() => service.importBundle(secondDocument, canonicalizeProjectBundle(tampered), { expectedRevision: 0 }), { code: 'PROJECT_BUNDLE_INTEGRITY_FAILED' });
  assert.throws(() => service.importBundle(otherDocument, exported, { expectedRevision: 0 }), { code: 'PROJECT_BUNDLE_SOURCE_MISMATCH', status: 409 });
  const extra = JSON.parse(exported); extra.extra = true;
  const canonicalExtra = canonicalizeProjectBundle(extra);
  assert.throws(() => service.importBundle(secondDocument, canonicalExtra, { expectedRevision: 0 }), { code: 'PROJECT_BUNDLE_INVALID' });
  assert.throws(() => service.importBundle(secondDocument, ' '.repeat(PROJECT_BUNDLE_MAX_BYTES + 1), { expectedRevision: 0 }), { code: 'PROJECT_BUNDLE_TOO_LARGE', status: 413 });
  assert.throws(() => service.importBundle(secondDocument, exported), { code: 'PROJECT_BUNDLE_REVISION_REQUIRED' });
  workspace.createEntity(secondDocument, 'annotations', { id: 'existing' });
  assert.throws(() => service.importBundle(secondDocument, exported, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT', status: 409 });
});

test('portable project bundles embed the exact PDF and restore workspace into a new local document', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'platen-portable-project-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const workspace = new WorkspaceStateStore(documents);
  const service = new ProjectBundleService(documents, workspace);
  const pdf = makeTextPdf('Portable project source');
  const original = await documents.createDocument({ stream: Readable.from([pdf]), displayName: 'drawing-set.pdf' });
  workspace.createEntity(original.id, 'measurements', {
    id: 'measurement-1', type: 'measurement', quantity: 3.25, unit: 'm',
  });

  const exported = await service.exportPortableBundle(original.id);
  assert.equal(exported.mediaType, PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE);
  assert.equal(exported.size, exported.prefix.length + pdf.length);
  assert.equal(exported.manifest.source.sha256, original.sha256);
  const bytes = Buffer.concat([exported.prefix, readFileSync(exported.sourcePath)]);
  const imported = await service.importPortableBundle(Readable.from([
    bytes.subarray(0, 7), bytes.subarray(7, 31), bytes.subarray(31),
  ]));

  assert.notEqual(imported.document.id, original.id);
  assert.equal(imported.document.sha256, original.sha256);
  assert.equal(imported.workspace.namespaces.measurements[0].quantity, 3.25);
  assert.equal(imported.workspace.revision, 1);
  assert.deepEqual(readFileSync(documents.getSourcePath(imported.document.id)), pdf);
});

test('portable project import rejects bad framing, trailing bytes, truncation, and embedded PDF tampering without retaining documents', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'platen-portable-project-invalid-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const workspace = new WorkspaceStateStore(documents);
  const service = new ProjectBundleService(documents, workspace);
  const pdf = makeTextPdf('Bound source');
  const original = await documents.createDocument({ stream: Readable.from([pdf]), displayName: 'source.pdf' });
  const exported = await service.exportPortableBundle(original.id);
  const valid = Buffer.concat([exported.prefix, pdf]);

  const badMagic = Buffer.from(valid); badMagic[0] ^= 0xff;
  await assert.rejects(service.importPortableBundle(Readable.from([badMagic])), { code: 'PORTABLE_PROJECT_INVALID_MAGIC' });
  await assert.rejects(service.importPortableBundle(Readable.from([valid.subarray(0, -1)])), { code: 'PORTABLE_PROJECT_TRUNCATED' });
  await assert.rejects(service.importPortableBundle(Readable.from([valid, Buffer.from('x')])), { code: 'PORTABLE_PROJECT_TRAILING_DATA' });
  const tamperedPdf = Buffer.from(valid); tamperedPdf[tamperedPdf.length - 1] ^= 1;
  const createDocument = documents.createDocument.bind(documents);
  let rejectedDocumentId = null;
  documents.createDocument = async (...args) => {
    const document = await createDocument(...args);
    rejectedDocumentId = document.id;
    return document;
  };
  await assert.rejects(service.importPortableBundle(Readable.from([tamperedPdf])), { code: 'PORTABLE_PROJECT_SOURCE_MISMATCH', status: 409 });
  assert.ok(rejectedDocumentId, 'tampered import must reach document staging before digest rejection');
  assert.throws(() => documents.getDocument(rejectedDocumentId), { code: 'DOCUMENT_NOT_FOUND', status: 404 });
});
