import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleScannerAcquisitionRoute } from '../scripts/host/routes/scanner-acquisition-routes.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const deviceId = `scanner-${'a'.repeat(32)}`;
const documentId = '123e4567-e89b-42d3-a456-426614174000';
const sha256 = 'b'.repeat(64);
const operationId = '123e4567-e89b-42d3-a456-426614174001';
const evidence = Object.freeze({ sourceFree: true, pageCount: 1, helperVerified: true, outputDigestBound: true, localOnly: true });
const helperFailureEvidence = Object.freeze({ api: 'ImageCaptureCore', discoveryAttempted: false, liveVerification: false, scanSupport: 'unsupported' });

function result() {
  const operation = {
    schemaVersion: 1, id: operationId, type: 'scan-acquire', inputs: [],
    parameters: { profile: 'local-scan-acquire-v1', deviceId, source: 'flatbed', duplex: false, color: 'color', dpi: 300, pageCount: 1, format: 'PDF' },
    expected: { pageCount: 1, outputSha256: sha256, sourceFree: true },
    validation: { passed: true, validators: ['pinned-helper-sha256', 'private-workspace', 'scanner-output-identity', 'scanner-output-digest', 'pdf-header', 'single-page-acquisition'], outputSha256: sha256 },
    completedAt: '2026-08-05T00:00:00.000Z',
  };
  const document = { id: documentId, displayName: 'scan.pdf', mediaType: 'application/pdf', size: 31, sha256, origin: 'derived', operation, createdAt: '2026-08-05T00:00:01.000Z' };
  return { kind: 'scan-acquire', document, operation, evidence };
}

function routeContext(overrides = {}) {
  const response = new EventEmitter(); response.destroyed = false;
  const controller = new AbortController();
  const current = result();
  const records = new Map([[documentId, current.document]]);
  return {
    pathname: '/api/scanners/acquire', request: { method: 'POST' }, response,
    url: new URL('http://127.0.0.1/api/scanners/acquire'), processing: { signal: controller.signal },
    scannerAcquisitionReady: true, scannerAcquisition: { acquire: async () => current },
    store: { getDocument: (id) => records.get(id), deleteDocument: async (id) => records.delete(id) },
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => ({ deviceId, color: 'color', dpi: 300 }),
    exactJsonObject: (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    json: (target, status, body) => { target.status = status; target.body = body; },
    controller, records, current, ...overrides,
  };
}

test('scanner acquisition route builds only the fixed profile and returns a revalidated public record', async () => {
  const context = routeContext(); let received;
  context.scannerAcquisition = { acquire: async (options, control) => { received = { options, control }; return context.current; } };
  assert.equal(await handleScannerAcquisitionRoute(context), true);
  assert.equal(context.response.status, 201);
  assert.deepEqual(context.response.body, { document: context.current.document, operation: context.current.operation, evidence });
  assert.deepEqual(received.options, { profile: 'local-scan-acquire-v1', deviceId, source: 'flatbed', duplex: false, color: 'color', dpi: 300, pageCount: 1, maxBytes: 64 * 1024 * 1024, deadlineMs: 120_000, format: 'PDF' });
  assert.equal(received.control.signal, context.processing.signal);
  assert.equal(Object.hasOwn(context.response.body.document, 'path'), false);
});

test('scanner acquisition route rejects query drift, unavailable helpers, and untrusted retained output', async () => {
  const query = routeContext({ url: new URL('http://127.0.0.1/api/scanners/acquire?path=1') });
  await assert.rejects(handleScannerAcquisitionRoute(query), { code: 'INVALID_PARAMETER', status: 400 });
  await assert.rejects(handleScannerAcquisitionRoute(routeContext({ scannerAcquisitionReady: false, scannerAcquisition: null })), { code: 'SCANNER_ACQUISITION_UNAVAILABLE', status: 503 });
  const forged = routeContext(); forged.records.set(documentId, { ...forged.current.document, sha256: 'c'.repeat(64) });
  await assert.rejects(handleScannerAcquisitionRoute(forged), { code: 'INVALID_SCANNER_ACQUISITION_RESULT', status: 502 });
});

test('scanner acquisition route preserves safe helper failure evidence and revokes on pre-delivery cancellation', async () => {
  const failed = routeContext({ scannerAcquisition: { acquire: async () => { const error = new HostError('SCANNER_SCAN_UNSUPPORTED', 'No scanner.', 503); error.evidence = helperFailureEvidence; throw error; } } });
  assert.equal(await handleScannerAcquisitionRoute(failed), true);
  assert.deepEqual(failed.response.body, { error: { code: 'SCANNER_SCAN_UNSUPPORTED', message: 'No scanner.', evidence: helperFailureEvidence } });
  const cancelled = routeContext(); cancelled.controller.abort();
  assert.equal(await handleScannerAcquisitionRoute(cancelled), true);
  assert.equal(cancelled.records.has(documentId), false);
});

test('application router authenticates acquisition and advertises the composed helper', async () => {
  const current = result();
  const records = new Map([[documentId, current.document]]);
  const token = 'c'.repeat(64);
  const handler = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    store: {
      getDocument: (id) => records.get(id),
      deleteDocument: async (id) => records.delete(id),
    },
    service: { availability: async () => [] },
    workspaceState: {},
    scannerAcquisition: { acquire: async () => current },
    scannerAcquisitionReady: true,
    token,
    host: '127.0.0.1',
    port: 4173,
  });
  const body = JSON.stringify({ deviceId, color: 'color', dpi: 300 });
  const unauthorized = await invoke(handler, {
    method: 'POST', url: '/api/scanners/acquire',
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body,
  });
  assert.equal(unauthorized.statusCode, 401);
  const acquired = await invoke(handler, {
    method: 'POST', url: '/api/scanners/acquire',
    headers: {
      origin: 'http://127.0.0.1:4173', 'content-type': 'application/json',
      'x-platen-token': token,
    },
    body,
  });
  assert.equal(acquired.statusCode, 201);
  assert.equal(JSON.parse(acquired.body).document.id, documentId);
  const bootstrap = await invoke(handler, { method: 'GET', url: '/api/bootstrap' });
  assert.equal(JSON.parse(bootstrap.body).host.scannerAcquisitionReady, true);
});
