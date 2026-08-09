import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormBarcodeService } from '../scripts/host/pdf-acroform-barcode-service.mjs';
import { inspectPdfAcroFormBarcode } from '../scripts/host/pdf-acroform-barcode-writer.mjs';
import { handleAcroFormBarcodeRoute } from '../scripts/host/routes/acroform-routes.mjs';
import { handleDocumentRoutes } from '../scripts/host/router-document-dispatch.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { barcodeFieldRequest, makeBarcodeFieldPdf } from './host-pdf-acroform-barcode-fixtures.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const documentId = '123e4567-e89b-42d3-a456-426614174000';
const sourceBytes = Buffer.from('source-pdf-fixture');
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const request = Object.freeze({
  profile: 'local-pdf-acroform-barcode-v1',
  sourceSha256,
  page: 1,
  fieldName: 'ShippingBarcode',
  rect: { x: 72, y: 640, width: 240, height: 48 },
  symbology: 'code39-basic',
  payload: 'ABC-123',
});

function receipt(body = request, overrides = {}) {
  const outputSha256 = 'b'.repeat(64);
  const { artifact: artifactOverrides = {}, ...resultOverrides } = overrides;
  const operation = {
    type: 'pdf-acroform-barcode',
    inputs: [{ documentId, sha256: body.sourceSha256, role: 'source' }],
    parameters: {
      profile: body.profile, page: body.page,
      fieldNameSha256: createHash('sha256').update(body.fieldName).digest('hex'),
      payloadSha256: createHash('sha256').update(body.payload, 'ascii').digest('hex'),
      symbology: body.symbology, rect: body.rect,
    },
    expected: { outputSha256 },
    validation: { passed: true, outputSha256 },
  };
  return {
    kind: 'pdf-acroform-barcode',
    artifact: {
      id: '123e4567-e89b-42d3-a456-426614174001', documentId,
      displayName: 'barcode-field.pdf', mediaType: 'application/pdf', size: 256,
      sha256: outputSha256, operation, createdAt: '2026-08-03T00:00:00.000Z',
      ...artifactOverrides,
    },
    proof: {
      profile: body.profile, sourceSha256: body.sourceSha256, page: body.page,
      fieldNameSha256: operation.parameters.fieldNameSha256,
      payloadSha256: operation.parameters.payloadSha256,
      symbology: body.symbology, rect: body.rect,
    },
    limitations: ['bounded Code 39'],
    ...resultOverrides,
  };
}

function routeContext(body = request, service = {}, { signal = new AbortController().signal, store: storeOverrides = {} } = {}) {
  const response = new EventEmitter();
  const deleted = [];
  const calls = [];
  return {
    request: { method: 'POST' },
    response,
    url: new URL(`http://local/api/documents/${documentId}/acroform-barcode`),
    documentId,
    operation: 'acroform-barcode',
    processing: { signal },
    store: { deleteArtifact: async (id) => { deleted.push(id); }, ...storeOverrides },
    acroFormBarcode: {
      add: async (...args) => { calls.push(args); return service.add ? service.add(...args) : receipt(body); },
    },
    method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
    calls,
    deleted,
  };
}

test('barcode route validates exact source-bound options and returns a disclosure-safe receipt', async () => {
  const context = routeContext();
  assert.equal(await handleAcroFormBarcodeRoute(context), true);
  assert.equal(context.response.status, 201);
  assert.deepEqual(context.calls[0][0], documentId);
  assert.deepEqual(context.calls[0][1], request);
  assert(context.calls[0][2].signal instanceof AbortSignal);
  assert.equal(context.response.value.result.artifact.documentId, documentId);
  assert.equal('filePath' in context.response.value.result.artifact, false);
  assert.equal(context.response.value.result.artifact.sha256, 'b'.repeat(64));
});

test('barcode route rejects malformed or stale requests before or through the service', async () => {
  for (const body of [
    { ...request, payload: 'abc' },
    { ...request, extra: true },
    { ...request, rect: { ...request.rect, width: 20 } },
  ]) {
    const context = routeContext(body);
    await assert.rejects(handleAcroFormBarcodeRoute(context), { code: 'INVALID_ACROFORM_BARCODE_OPTIONS' });
    assert.equal(context.calls.length, 0);
  }
  const stale = routeContext(request, { add: async () => { const error = new Error('stale'); error.code = 'SOURCE_VERSION_MISMATCH'; throw error; } });
  await assert.rejects(handleAcroFormBarcodeRoute(stale), { code: 'SOURCE_VERSION_MISMATCH' });
});

test('barcode route rejects forged service receipts and cleans the promoted artifact', async () => {
  const foreignId = '123e4567-e89b-42d3-a456-426614174002';
  const foreign = { ...receipt(request).artifact, id: foreignId, documentId: 'other-document' };
  const forged = routeContext(request, { add: async () => receipt(request, { artifact: { id: foreignId, documentId: 'other-document' } }) }, { store: { getArtifact: async () => foreign } });
  await assert.rejects(handleAcroFormBarcodeRoute(forged), { code: 'ACROFORM_BARCODE_RESULT_INVALID' });
  assert.deepEqual(forged.deleted, []);
  const tampered = routeContext(request, { add: async () => receipt(request, { artifact: { sha256: 'c'.repeat(64) } }) }, { store: { getArtifact: async () => receipt(request).artifact } });
  await assert.rejects(handleAcroFormBarcodeRoute(tampered), { code: 'ACROFORM_BARCODE_RESULT_INVALID' });
  assert.deepEqual(tampered.deleted, []);
  const captured = routeContext(request, { add: async () => receipt(request, { proof: { profile: request.profile, sourceSha256: request.sourceSha256, page: 1, fieldNameSha256: 'f'.repeat(64), payloadSha256: 'f'.repeat(64), symbology: request.symbology, rect: request.rect } }) }, { store: { getArtifact: async () => receipt(request).artifact } });
  await assert.rejects(handleAcroFormBarcodeRoute(captured), { code: 'ACROFORM_BARCODE_RESULT_INVALID' });
  assert.deepEqual(captured.deleted, ['123e4567-e89b-42d3-a456-426614174001']);
});

test('barcode route propagates unavailable and cancellation failures', async () => {
  const unavailable = routeContext(); unavailable.acroFormBarcode = null;
  await assert.rejects(handleAcroFormBarcodeRoute(unavailable), { code: 'ACROFORM_BARCODE_UNAVAILABLE' });
  const cancelled = routeContext(request, { add: async () => { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; } });
  await assert.rejects(handleAcroFormBarcodeRoute(cancelled), { code: 'JOB_CANCELLED' });
});

test('document dispatcher admits the barcode operation', async () => {
  let dispatched = false;
  const routes = new Proxy({}, { get: (_target, key) => async (context) => { if (key === 'acroFormBarcode') { dispatched = context.operation === 'acroform-barcode'; return true; } return false; } });
  assert.equal(await handleDocumentRoutes({ pathname: `/api/documents/${documentId}/acroform-barcode`, request: {}, response: {}, url: new URL(`http://local/api/documents/${documentId}/acroform-barcode`), processing: {}, store: {}, workspaceState: {}, routes, limits: {} }), true);
  assert.equal(dispatched, true);
});

test('authenticated app route reaches the retained barcode service and rereads its artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forms-barcode-route-'));
  const store = await new (DocumentStore)({ root }).initialize();
  t.after(() => store.dispose());
  const source = makeBarcodeFieldPdf();
  const document = await store.createDocument({ stream: (async function* () { yield source; }()), displayName: 'source.pdf' });
  const body = barcodeFieldRequest(source);
  const app = createAppHandler({
    staticHandler: () => {}, store, service: {}, workspaceState: {},
    acroFormBarcode: new PdfAcroFormBarcodeService({ store }), token: 'token', host: '127.0.0.1', port: 4173,
  });
  const response = await invoke(app, { method: 'POST', url: `/api/documents/${document.id}/acroform-barcode`, headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': 'token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.statusCode, 201);
  const result = JSON.parse(response.body).result;
  assert.equal(result.artifact.documentId, document.id);
  assert.equal(result.artifact.sha256, result.artifact.operation.validation.outputSha256);
  assert.equal('filePath' in result.artifact, false);
  const retained = store.getArtifact(result.artifact.id);
  const output = await readFile(retained.filePath);
  assert.equal(createHash('sha256').update(output).digest('hex'), retained.sha256);
  assert.deepEqual(inspectPdfAcroFormBarcode(source, output, body), result.proof);
  await store.deleteArtifact(result.artifact.id);
  const unauthenticated = await invoke(app, { method: 'POST', url: `/api/documents/${document.id}/acroform-barcode`, headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(unauthenticated.statusCode, 401);
});
