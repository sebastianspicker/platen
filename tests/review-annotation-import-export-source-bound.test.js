import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { PdfReviewAnnotationImportExportService } from '../scripts/host/pdf-review-annotation-import-export-service.mjs';
import { handleReviewAnnotationImportExportRoute } from '../scripts/host/routes/review-annotation-import-export-routes.mjs';
import {
  createReviewAnnotationImportExportEndpoints,
  PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE,
} from '../src/core/local-host-review-annotation-import-export-endpoints.js';

const sourceDigest = 'a'.repeat(64);
const annotation = Object.freeze({ subtype: 'Text', page: 1, rect: [10, 20, 80, 90], contentsSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64) });
const xfdf = '<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots><text page="0" rect="10,20,80,90"><contents>note</contents></text></annots></xfdf>\n';
const request = Object.freeze({ profile: PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE, sourceSha256: sourceDigest, expectedRevision: 0, xfdf });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function response() { const value = new EventEmitter(); value.destroyed = false; return value; }
function result(documentId, input = request) {
  const output = 'c'.repeat(64);
  return {
    kind: 'pdf-review-annotation-import-export', sourceDigest: input.sourceSha256, revision: input.expectedRevision,
    artifact: { id: randomUUID(), documentId, displayName: 'source-review-annotation.pdf', mediaType: 'application/pdf', size: 100, sha256: output, operation: { schemaVersion: 1 }, createdAt: '2026-08-03T00:00:00.000Z' },
    annotation: { ...annotation, outputSha256: output }, xfdf: input.xfdf,
    evidence: { sourceDigestReverified: true, sourceRevisionReverified: true, sourcePrefixPreserved: true, canonicalXfdfTextOnly: true, inertTextAnnotationReinspected: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: ['one'],
  };
}

test('source-bound review annotation import/export creates a separate append-only artifact and canonical XFDF', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'review-annotation-import-export-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = createBlankPdf({ pages: 1, title: 'annotation import' });
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const documentId = randomUUID(); const sourceSha256 = digest(source); const artifacts = new Map(); const workspaces = [];
  const store = {
    getDocument: (id) => { assert.equal(id, documentId); return { id, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }; },
    getSourcePath: () => sourcePath,
    async verifySource() { assert.equal(digest(await readFile(sourcePath)), sourceSha256); },
    async createJobWorkspace() { const path = await mkdtemp(join(root, 'job-')); workspaces.push(path); return path; },
    async cleanupJob(path) { await rm(path, { recursive: true, force: true }); },
    async promotePdfArtifact(id, path, options) { const bytes = await readFile(path); const artifact = { id: randomUUID(), documentId: id, displayName: options.displayName, mediaType: 'application/pdf', size: bytes.length, sha256: digest(bytes), operation: options.operation, createdAt: '2026-08-03T00:00:00.000Z' }; artifacts.set(artifact.id, artifact); return artifact; },
    async deleteArtifact(id) { artifacts.delete(id); },
  };
  const service = new PdfReviewAnnotationImportExportService({ store, workspaceState: { snapshot: () => ({ revision: 0 }) } });
  const value = { ...request, sourceSha256 };
  const output = await service.importExport(documentId, value, { sourceSha256 });
  assert.equal(output.artifact.documentId, documentId); assert.equal(output.xfdf, xfdf); assert.equal(output.annotation.subtype, 'Text');
  assert.equal(output.evidence.sourcePrefixPreserved, true); assert.equal(Object.isFrozen(output), true); assert.equal(Object.isFrozen(output.annotation), true); assert.equal(artifacts.size, 1); assert.equal(digest(await readFile(sourcePath)), sourceSha256);
  await Promise.all(workspaces.map((path) => assert.rejects(readFile(path))));
  await assert.rejects(service.importExport(documentId, { ...value, xfdf: xfdf.replace('<text ', '<text extra="x" ') }, { sourceSha256 }), { code: 'INVALID_ANNOTATION_XFDF' });
  const controller = new AbortController(); const promote = store.promotePdfArtifact;
  store.promotePdfArtifact = async (...args) => { const promoted = await promote(...args); controller.abort(); return promoted; };
  await assert.rejects(service.importExport(documentId, value, { sourceSha256, signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(artifacts.size, 1);
});

test('review annotation route requires an exact canonical source-bound request and returns only a verified service result', async () => {
  const documentId = randomUUID(); const current = { id: documentId, sha256: sourceDigest };
  const calls = []; const res = response(); let payload;
  const handled = await handleReviewAnnotationImportExportRoute({
    operation: 'review-annotation-import-export', request: {}, response: res, url: new URL('http://localhost/api/documents/x/review-annotation-import-export'), documentId,
    processing: { signal: new AbortController().signal }, store: { getDocument: () => current }, reviewAnnotationImportExport: { async importExport(...args) { calls.push(args); return result(documentId); } }, bodyLimit: 32768,
    exactJsonObject: (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), method: (_request, expected) => assert.equal(expected, 'POST'), readJson: async () => ({ ...request }), json: (_response, status, body) => { payload = { status, body }; },
  });
  assert.equal(handled, true); assert.equal(calls.length, 1); assert.equal(payload.status, 201); assert.equal(payload.body.result.xfdf, xfdf);
});

test('review annotation client posts the authenticated R04 contract and freezes only a source-bound response', async () => {
  const documentId = randomUUID(); let sent;
  const endpoints = createReviewAnnotationImportExportEndpoints({ json: async (path, options) => { sent = { path, options }; return { result: result(documentId) }; } });
  const output = await endpoints.importReviewAnnotationXfdf(documentId, request);
  assert.equal(sent.path, `/api/documents/${encodeURIComponent(documentId)}/review-annotation-import-export`); assert.equal(JSON.parse(sent.options.body).xfdf, xfdf); assert.equal(Object.isFrozen(output), true); assert.equal(Object.isFrozen(output.annotation), true);
  await assert.rejects(async () => endpoints.importReviewAnnotationXfdf(documentId, { ...request, xfdf: 'FDF' }), TypeError);
});
