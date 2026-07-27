import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleIncrementalGoToLinkRoute } from '../scripts/host/routes/incremental-goto-link-routes.mjs';
import { PdfIncrementalGoToLinkService } from '../scripts/host/pdf-incremental-goto-link-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';

const digest = 'a'.repeat(64);
const requestValue = { profile: 'local-incremental-goto-link-v1', sourcePage: 1, targetPage: 1, rect: { left: 0, bottom: 0, right: 1, top: 1 } };
function context(body = { ...requestValue, sourceSha256: digest }, { aborted = false } = {}) {
  const response = new EventEmitter(); const calls = []; const deleted = [];
  const controller = new AbortController(); if (aborted) controller.abort();
  return { request: { method: 'POST' }, response, url: new URL('http://local.test/api/documents/id/incremental-goto-link'), documentId: 'id', operation: 'incremental-goto-link', processing: { signal: controller.signal }, store: { deleteArtifact: async (id) => { deleted.push(id); } }, incrementalGoToLink: { update: async (...args) => { calls.push(args); return { artifact: { id: 'artifact' }, kind: 'pdf-incremental-goto-link' }; } }, bodyLimit: 2048, exactJsonObject: (value, keys) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (request, expected) => assert.equal(request.method, expected), readJson: async () => body, json: (_response, status, value) => { response.status = status; response.value = value; }, calls, deleted };
}
test('GoTo-link route accepts only the fixed request and delegates a source-bound host operation', async () => {
  const value = context(); assert.equal(await handleIncrementalGoToLinkRoute(value), true); assert.equal(value.response.status, 201); assert.deepEqual(value.calls[0][1], requestValue); assert.equal(value.calls[0][2].sourceSha256, digest);
  const invalid = context({ ...requestValue, sourceSha256: digest.toUpperCase() }); await assert.rejects(handleIncrementalGoToLinkRoute(invalid), { code: 'INVALID_INCREMENTAL_GOTO_LINK_OPTIONS' });
});

test('GoTo-link route rolls back a promoted artifact when delivery is already cancelled', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleIncrementalGoToLinkRoute(value), true);
  assert.deepEqual(value.deleted, ['artifact']);
  assert.equal(value.response.status, undefined);
});

test('router supplies artifact authority when a GoTo-link response disconnects after promotion', async () => {
  const deleted = []; const response = new EventEmitter();
  response.destroyed = false; response.writableEnded = false;
  const store = { deleteArtifact: async (id) => { deleted.push(id); } };
  const incrementalGoToLink = { async update() {
    response.destroyed = true; response.emit('close');
    return { artifact: { id: 'router-artifact' }, kind: 'pdf-incremental-goto-link' };
  } };
  const handler = createAppHandler({
    staticHandler() {}, store, service: {}, workspaceState: {}, incrementalGoToLink,
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const request = Readable.from([JSON.stringify({ ...requestValue, sourceSha256: digest })]);
  Object.assign(request, {
    method: 'POST', url: '/api/documents/id/incremental-goto-link',
    headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json', 'x-platen-token': 'token',
    },
  });
  await handler(request, response);
  assert.deepEqual(deleted, ['router-artifact']);
});
test('bootstrap exposes GoTo-link readiness without requiring a browser contract', async () => {
  const response = {}; await handleBootstrapRoute({ pathname: '/api/bootstrap', request: { method: 'GET' }, response, service: { availability: async () => [] }, inputs: null, conversion: null, domainFacade: null, aecArtifacts: null, projectBundles: null, accessibilityRemediations: null, standardsValidations: null, incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: {}, pdfkitInspections: null, pdfkitOutlineSplits: null, pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null, redactionPlans: null, signatureTrustReady: false, pluginSandboxProbeReady: false, token: 'token', method: () => {}, requireLocalFetchMetadata: () => {}, json: (_response, _status, value) => { response.value = value; }, sanitizedEngineAvailability: (value) => value }); assert.equal(response.value.host.incrementalGoToLinkReady, true);
});

test('GoTo-link service stages, independently reinspects, validates, and promotes a source-bound artifact', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'goto-link-service-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from(`%PDF-1.4\n${'source '.repeat(20)}\nstartxref\n10\n%%EOF\n`); const output = Buffer.concat([source, Buffer.from('append '.repeat(20))]); const sha256 = createHash('sha256').update(source).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const proof = Object.freeze({ profile: requestValue.profile, sourceBytes: source.length, outputBytes: output.length, appendedBytes: output.length - source.length, sourcePrefixPreserved: true, revisionCount: 2, previousXrefOffset: 10, appendedXrefOffset: source.length, sourcePage: 1, targetPage: 1, rect: requestValue.rect, sourcePageObjectNumber: 3, targetPageObjectNumber: 3, linkAnnotationObjectNumber: 5, annotationCount: 1, effectiveSize: 6, rootPreserved: true, infoPreserved: true, idPolicy: 'absent' });
  const documentId = '11111111-1111-4111-8111-111111111111'; const store = { getDocument: () => ({ id: documentId, sha256, size: source.length, displayName: 'source.pdf' }), getSourcePath: () => sourcePath, verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sha256), createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; }, cleanupJob: (path) => rm(path, { recursive: true, force: true }), promotePdfArtifact: async (_id, path, options) => ({ id: 'artifact', sha256: options.expectedSha256, displayName: 'goto.pdf', operation: options.operation }), deleteArtifact: async () => {} };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const info = 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n'; const boxes = 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n';
  const poppler = { execute: async (operation, parameters) => { if (operation === 'inspect') return { stdout: info, stderr: '' }; if (['inspectMetadata', 'inspectCustomMetadata'].includes(operation)) return { stdout: '', stderr: '' }; if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' }; if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' }; if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 }; if (operation === 'inspectPageBoxes') return { stdout: boxes, stderr: '' }; if (operation === 'extractText') return { stdout: 'fixture\f', stderr: '' }; if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, png); return { stdout: '', stderr: '' }; } assert.fail(operation); } };
  const core = { normalizeIncrementalGoToLink: (value) => value, writeIncrementalPdfGoToLink: () => ({ bytes: Buffer.from(output), proof }), inspectIncrementalPdfGoToLink: () => proof };
  const result = await new PdfIncrementalGoToLinkService({ store, poppler, core }).update(documentId, requestValue, { sourceSha256: sha256 }); assert.equal(result.kind, 'pdf-incremental-goto-link'); assert.equal(result.artifact.sha256, createHash('sha256').update(output).digest('hex'));
});
