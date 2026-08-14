import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import { GhostscriptAdapter } from '../scripts/host/adapters/ghostscript.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { ConversionService } from '../scripts/host/conversion-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { deliverProfessionalCapability, listProfessionalHandlers } from '../scripts/host/professional-capability/index.mjs';
import { createProfessionalPrintDelivery } from '../scripts/host/professional-capability/standards-preflight-print-core.mjs';
import { handleDocumentRoutes } from '../scripts/host/router-document-dispatch.mjs';
import { handleProfessionalPrintTransparencyRoute } from '../scripts/host/routes/professional-print-transparency-routes.mjs';
import { scheduleDocumentCleanup } from '../scripts/host/routes/artifact-response-lifecycle.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';
import {
  PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY,
  PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE,
  PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION,
} from '../src/core/professional-print-transparency-contract.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const outputId = '22222222-2222-4222-8222-222222222222';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);

function validResult() {
  return {
    kind: 'professional-capability-result', schemaVersion: 1,
    capabilityId: PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY, ok: true, localOnly: true,
    method: 'validated-ghostscript-transparency-flatten-service', profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE,
    sourceSha256, outputDocumentId: outputId, outputSha256, size: 128, pageCount: 1,
    operationType: 'flatten-transparency', compatibilityLevel: '1.3', flatteningVerified: false,
    authoritative: false, certified: false, limitations: [PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION],
  };
}

function storeFixture({ derived = true } = {}) {
  const deleted = [];
  const documents = new Map([
    [sourceId, { id: sourceId, origin: 'uploaded', sha256: sourceSha256 }],
  ]);
  if (derived) documents.set(outputId, {
    id: outputId, origin: 'derived', sha256: outputSha256,
    operation: { type: 'flatten-transparency', inputs: [{ role: 'primary', documentId: sourceId, sha256: sourceSha256 }] },
  });
  return {
    deleted,
    getDocument(id) { const value = documents.get(id); if (!value) throw new HostError('DOCUMENT_NOT_FOUND', 'missing', 404); return value; },
    async deleteDocument(id) { deleted.push(id); documents.delete(id); },
  };
}

function fixture({ body = { profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE, sourceSha256 }, result = validResult(), store = storeFixture(), signal = new AbortController().signal, method = 'POST', search = '' } = {}) {
  const request = { method };
  const response = new EventEmitter(); response.destroyed = false; response.writableEnded = false;
  const writes = [];
  return {
    writes, store, response,
    context: {
      operation: 'professional-print-transparency', request, response,
      url: new URL(`http://127.0.0.1/api/documents/${sourceId}/professional-print-transparency${search}`),
      documentId: sourceId, processing: { signal }, store, bodyLimit: 2_048,
      professionalCapabilities: { async deliverPrintSourceBound(capability, context) {
        assert.equal(capability, PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY);
        assert.equal(context.documentId, sourceId);
        assert.equal(context.sourceSha256, sourceSha256);
        assert.equal(context.quality, 'medium');
        assert.ok(context.signal instanceof AbortSignal);
        return result;
      } },
      method: (actual, expected) => { if (actual.method !== expected) throw new HostError('METHOD_NOT_ALLOWED', 'method', 405); },
      readJson: async () => body,
      json: (_response, status, value) => writes.push({ status, value }),
    },
  };
}

test('transparency route accepts exact source-bound request and schedules derived document after response', async () => {
  const f = fixture();
  assert.equal(await handleProfessionalPrintTransparencyRoute(f.context), true);
  assert.equal(f.writes[0].status, 201);
  assert.equal(f.writes[0].value.result.outputDocumentId, outputId);
  f.response.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.store.deleted, []);
});

test('transparency route rejects invalid boundary inputs and unavailable capability', async () => {
  await assert.rejects(handleProfessionalPrintTransparencyRoute(fixture({ method: 'GET' }).context), { code: 'METHOD_NOT_ALLOWED', status: 405 });
  await assert.rejects(handleProfessionalPrintTransparencyRoute(fixture({ search: '?unsafe=1' }).context), { code: 'INVALID_PARAMETER', status: 400 });
  await assert.rejects(handleProfessionalPrintTransparencyRoute(fixture({ body: { profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE } }).context), { code: 'PROFESSIONAL_PRINT_OPTIONS_INVALID', status: 400 });
  const unavailable = fixture(); unavailable.context.professionalCapabilities = null;
  await assert.rejects(handleProfessionalPrintTransparencyRoute(unavailable.context), { code: 'PROFESSIONAL_PRINT_UNAVAILABLE', status: 503 });
});

test('invalid result cleanup is store-confirmed and never deletes source or forged ids', async () => {
  const invalid = fixture({ result: { ...validResult(), extra: true } });
  await assert.rejects(handleProfessionalPrintTransparencyRoute(invalid.context), { code: 'INVALID_PROFESSIONAL_PRINT_RESULT', status: 502 });
  assert.deepEqual(invalid.store.deleted, [outputId]);
  const forgedStore = storeFixture({ derived: false });
  const forged = fixture({ result: { ...validResult(), outputDocumentId: '33333333-3333-4333-8333-333333333333', extra: true }, store: forgedStore });
  await assert.rejects(handleProfessionalPrintTransparencyRoute(forged.context), { code: 'INVALID_PROFESSIONAL_PRINT_RESULT', status: 502 });
  assert.deepEqual(forgedStore.deleted, []);
});

test('document response cleanup handles pre-response abort, close-before-finish, and finish', async () => {
  const store = storeFixture();
  const aborted = new AbortController(); aborted.abort();
  const response = new EventEmitter(); response.destroyed = false;
  assert.equal(await scheduleDocumentCleanup({ processing: { signal: aborted.signal }, response, store }, outputId), true);
  assert.deepEqual(store.deleted, [outputId]);

  const closeStore = storeFixture();
  const closeResponse = new EventEmitter(); closeResponse.destroyed = false;
  assert.equal(await scheduleDocumentCleanup({ processing: { signal: new AbortController().signal }, response: closeResponse, store: closeStore }, outputId), false);
  closeResponse.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closeStore.deleted, [outputId]);

  const finishedStore = storeFixture();
  const finishedResponse = new EventEmitter(); finishedResponse.destroyed = false;
  await scheduleDocumentCleanup({ processing: { signal: new AbortController().signal }, response: finishedResponse, store: finishedStore }, outputId);
  finishedResponse.emit('finish'); finishedResponse.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finishedStore.deleted, []);
});

test('document dispatcher admits only the exact transparency operation', async () => {
  let observed;
  const routes = new Proxy({}, { get(_target, property) {
    if (property === 'workspace') return async () => false;
    if (property === 'workflow') return async (context) => { observed = context; return true; };
    return async () => false;
  } });
  assert.equal(await handleDocumentRoutes({
    pathname: `/api/documents/${sourceId}/professional-print-transparency`, request: {}, response: {},
    url: new URL(`http://127.0.0.1/api/documents/${sourceId}/professional-print-transparency`),
    processing: { signal: new AbortController().signal }, store: {}, workspaceState: {}, routes,
    limits: { professionalPrintTransparency: 2_048 }, professionalCapabilities: {},
  }), true);
  assert.equal(observed.operation, 'professional-print-transparency');
});

test('application router authenticates, gates origin, enforces content type and body size', async () => {
  const token = 'r08-transparency-token';
  const calls = [];
  const store = storeFixture();
  const handler = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    store, service: {}, workspaceState: {}, token, host: '127.0.0.1', port: 4173,
    professionalCapabilities: {
      async deliverPrintSourceBound(capability, context) {
        calls.push({ capability, context });
        return validResult();
      },
    },
  });
  const path = `/api/documents/${sourceId}/professional-print-transparency`;
  const body = JSON.stringify({ profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE, sourceSha256 });
  const baseHeaders = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' };

  let response = await invoke(handler, { method: 'POST', url: path, headers: baseHeaders, body });
  assert.equal(response.statusCode, 401);
  response = await invoke(handler, {
    method: 'POST', url: path,
    headers: { ...baseHeaders, origin: 'https://attacker.invalid', 'x-platen-token': token }, body,
  });
  assert.equal(response.statusCode, 403);
  response = await invoke(handler, {
    method: 'POST', url: path, headers: { ...baseHeaders, 'x-platen-token': token }, body,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY);
  assert.equal(calls[0].context.quality, 'medium');

  response = await invoke(handler, {
    method: 'POST', url: path,
    headers: { origin: baseHeaders.origin, 'x-platen-token': token }, body,
  });
  assert.equal(response.statusCode, 415);
  response = await invoke(handler, {
    method: 'POST', url: path,
    headers: { ...baseHeaders, 'content-type': 'text/plain', 'x-platen-token': token }, body,
  });
  assert.equal(response.statusCode, 415);
  response = await invoke(handler, {
    method: 'POST', url: path, headers: { ...baseHeaders, 'x-platen-token': token },
    body: JSON.stringify({ profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE, sourceSha256, padding: 'x'.repeat(2_048) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(calls.length, 1);
});

test('route deletes the validated output before responding when already aborted or destroyed', async () => {
  const abortedController = new AbortController();
  abortedController.abort();
  for (const setup of [
    { signal: abortedController.signal, destroyed: false },
    { signal: new AbortController().signal, destroyed: true },
  ]) {
    const f = fixture();
    f.context.processing.signal = setup.signal;
    f.response.destroyed = setup.destroyed;
    assert.equal(await handleProfessionalPrintTransparencyRoute(f.context), true);
    assert.deepEqual(f.store.deleted, [outputId]);
    assert.deepEqual(f.writes, []);
  }
});

test('invalid-result cleanup failures surface deterministically', async () => {
  const f = fixture({ result: { ...validResult(), extra: true } });
  f.store.deleteDocument = async () => { throw new Error('cleanup failed'); };
  await assert.rejects(handleProfessionalPrintTransparencyRoute(f.context), { code: 'PROFESSIONAL_PRINT_CLEANUP_FAILED', status: 500 });
  assert.deepEqual(f.writes, []);
});

test('installed Ghostscript delivery retains an exact source-bound transparency rewrite', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/gs'].map((path) => access(path)));
  } catch {
    context.skip('The fixed /opt/homebrew Poppler/Ghostscript toolchain is unavailable.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-r08-transparency-installed-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => store.dispose());
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const poppler = new PopplerAdapter({ registry, runner });
  const conversion = new ConversionService({
    documents: store,
    inputs,
    poppler,
    ghostscript: new GhostscriptAdapter({ registry, runner }),
    libreOffice: { execute() {} },
    imageMagick: { execute() {} },
  });
  const sourceBytes = createTextPdf({ text: 'R08 transparency source', title: 'R08 source' });
  const source = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf' });
  const sourceBefore = await readFile(store.getSourcePath(source.id));
  const professional = createProfessionalPrintDelivery({
    store, services: { conversion }, deliver: deliverProfessionalCapability, list: listProfessionalHandlers,
  });
  const result = await professional.deliverSourceBound(PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY, {
    documentId: source.id, sourceSha256: source.sha256, quality: 'medium', signal: new AbortController().signal,
  });
  assert.equal(result.method, 'validated-ghostscript-transparency-flatten-service');
  assert.equal(result.profile, PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE);
  assert.equal(result.sourceSha256, source.sha256);
  assert.equal(result.operationType, 'flatten-transparency');
  assert.equal(result.compatibilityLevel, '1.3');
  assert.equal(result.flatteningVerified, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.certified, false);
  assert.deepEqual(result.limitations, [PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION]);
  assert.notEqual(result.outputDocumentId, source.id);
  const output = store.getDocument(result.outputDocumentId);
  assert.equal(output.origin, 'derived');
  assert.equal(output.sha256, result.outputSha256);
  assert.equal(output.size, result.size);
  assert.equal(output.operation.type, 'flatten-transparency');
  assert.deepEqual(output.operation.inputs, [{ documentId: source.id, sha256: source.sha256, role: 'primary' }]);
  assert.deepEqual(output.operation.validation.validators, ['source-sha256', 'pdfinfo-page-count']);
  assert.equal(output.operation.validation.pageCount, result.pageCount);
  assert.deepEqual(await readFile(store.getSourcePath(source.id)), sourceBefore);
  await store.deleteDocument(output.id);
});
