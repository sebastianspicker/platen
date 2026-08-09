import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createProfessionalPrintTransparencyEndpoints } from '../src/core/local-host-professional-print-transparency-endpoints.js';
import {
  PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY,
  PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION,
  PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE,
  normalizeProfessionalPrintTransparencyRequest,
  validateProfessionalPrintTransparencyResponse,
} from '../src/core/professional-print-transparency-contract.js';

const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const documentId = '123e4567-e89b-12d3-a456-426614174000';
const outputDocumentId = '123e4567-e89b-12d3-a456-426614174001';
const request = { profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE, sourceSha256 };

function result(overrides = {}) {
  return {
    kind: 'professional-capability-result', schemaVersion: 1,
    capabilityId: PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY, ok: true, localOnly: true,
    method: 'validated-ghostscript-transparency-flatten-service', profile: PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE,
    sourceSha256, outputDocumentId, outputSha256, size: 1024, pageCount: 1,
    operationType: 'flatten-transparency', compatibilityLevel: '1.3', flatteningVerified: false,
    authoritative: false, certified: false, limitations: [PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION], ...overrides,
  };
}

test('R08 transparency client accepts exact fixed request and response snapshots', () => {
  const original = { ...request };
  const normalized = normalizeProfessionalPrintTransparencyRequest(original);
  original.sourceSha256 = 'c'.repeat(64);
  assert.deepEqual(normalized, request);
  assert(Object.isFrozen(normalized));
  const validated = validateProfessionalPrintTransparencyResponse({ result: result() }, request);
  assert(Object.isFrozen(validated));
  assert(Object.isFrozen(validated.limitations));
  assert.notEqual(validated, result());
});

test('R08 transparency client posts the exact fixed body and supports AbortSignal', async () => {
  const calls = [];
  const controller = new AbortController();
  const endpoints = createProfessionalPrintTransparencyEndpoints({
    json: async (path, options) => { calls.push({ path, options }); return { result: result() }; },
  });
  const validated = await endpoints.flattenPrintTransparency(documentId, request, { signal: controller.signal });
  assert.equal(validated.outputDocumentId, outputDocumentId);
  assert.equal(calls[0].path, `/api/documents/${documentId}/professional-print-transparency`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
  assert.equal(calls[0].options.signal, controller.signal);
});

test('R08 transparency client rejects hostile graphs, extras, and uppercase hashes', () => {
  for (const hostile of [null, [], Object.create(null), new Proxy(request, {}), { ...request, extra: true }]) {
    assert.throws(() => normalizeProfessionalPrintTransparencyRequest(hostile), TypeError);
  }
  const accessor = {};
  Object.defineProperty(accessor, 'profile', { enumerable: true, get: () => PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE });
  Object.defineProperty(accessor, 'sourceSha256', { enumerable: true, value: sourceSha256 });
  assert.throws(() => normalizeProfessionalPrintTransparencyRequest(accessor), TypeError);
  const cyclic = { ...request }; cyclic.self = cyclic;
  assert.throws(() => normalizeProfessionalPrintTransparencyRequest(cyclic), TypeError);
  assert.throws(() => normalizeProfessionalPrintTransparencyRequest({ ...request, sourceSha256: sourceSha256.toUpperCase() }), TypeError);
  assert.throws(() => normalizeProfessionalPrintTransparencyRequest({ ...request, sourceSha256: 'a'.repeat(63) }), TypeError);
  assert.throws(() => normalizeProfessionalPrintTransparencyRequest({ profile: 'other', sourceSha256 }), TypeError);
});

test('R08 transparency client rejects forged, drifting, and equal output identities', async () => {
  for (const overrides of [
    { sourceSha256: 'c'.repeat(64) },
    { outputSha256: outputSha256.toUpperCase() },
    { capabilityId: 'other.capability' },
    { ok: false },
    { size: 512 * 1024 * 1024 + 1 },
    { pageCount: 0 },
    { limitations: ['forged'] },
  ]) {
    await assert.rejects(createProfessionalPrintTransparencyEndpoints({ json: async () => ({ result: result(overrides) }) })
      .flattenPrintTransparency(documentId, request), TypeError);
  }
  await assert.rejects(createProfessionalPrintTransparencyEndpoints({ json: async () => ({ result: result({ outputDocumentId: documentId }) }) })
    .flattenPrintTransparency(documentId, request), TypeError);
  await assert.rejects(createProfessionalPrintTransparencyEndpoints({ json: async () => ({ result: result({ outputDocumentId: 'not-an-id' }) }) })
    .flattenPrintTransparency(documentId, request), TypeError);
  await assert.rejects(createProfessionalPrintTransparencyEndpoints({ json: async () => ({ result: result(), extra: true }) })
    .flattenPrintTransparency(documentId, request), TypeError);
});

test('R08 LocalHostClient bootstraps and authenticates transparency transport', async () => {
  const token = 'd'.repeat(64);
  const calls = [];
  const client = new LocalHostClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token, engines: [] }), { status: 200 });
      return new Response(JSON.stringify({ result: result() }), { status: 200 });
    },
  });
  await client.bootstrap();
  const controller = new AbortController();
  await client.flattenPrintTransparency(documentId, request, { signal: controller.signal });
  assert.equal(calls[1].path, `/api/documents/${documentId}/professional-print-transparency`);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[1].options.signal, controller.signal);
});
