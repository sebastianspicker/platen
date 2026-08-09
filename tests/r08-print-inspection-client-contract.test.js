import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createProfessionalPrintInspectionEndpoints } from '../src/core/local-host-professional-print-inspection-endpoints.js';
import {
  normalizeProfessionalPrintInspectionRequest,
  validateProfessionalPrintInspectionResult,
} from '../src/core/professional-print-inspection-contract.js';

const sourceSha256 = 'a'.repeat(64);
const documentId = randomUUID();

function fontRecord() {
  return { name: 'Helvetica', type: 'Type 1', encoding: 'WinAnsi', embedded: 'yes', subset: 'no', unicode: 'yes', sourceSha256 };
}

function imageRecord() {
  return { page: 1, number: 0, type: 'image', width: 600, height: 800, color: 'rgb', bitsPerComponent: 8, encoding: 'jpeg', objectId: 7, generation: 0, xPpi: 300, yPpi: 300, sourceSha256 };
}

function resultFor(capabilityId) {
  const common = {
    kind: 'professional-capability-result', schemaVersion: 1, capabilityId, ok: true, localOnly: true,
    sourceSha256, inspected: true, authoritative: false, certified: false,
  };
  if (capabilityId === 'print.font-inspection-embedding') return {
    ...common, method: 'validated-local-font-inventory', fonts: [fontRecord()], fontCount: 1,
    returnedFontCount: 1, truncated: false, missingEmbedCount: 0,
    limitations: ['Embedding and subsetting are reported from local inspection evidence; no press certification or outline conversion is performed.'],
  };
  return {
    ...common, method: 'validated-local-image-inventory', images: [imageRecord()], imageCount: 1,
    returnedImageCount: 1, truncated: false, dpiThreshold: 150, belowThreshold: false,
    belowThresholdCount: 0, unknownResolutionCount: 0, compressionControlled: false,
    limitations: ['Resolution is a bounded review threshold; no recompression or press suitability claim is made.'],
  };
}

test('print inspection contract normalizes both request shapes and returns deeply frozen snapshots', () => {
  const fontRequest = normalizeProfessionalPrintInspectionRequest({ capabilityId: 'print.font-inspection-embedding', sourceSha256 });
  const imageRequest = normalizeProfessionalPrintInspectionRequest({ sourceSha256 }, 'print.image-resolution-compression');
  assert.deepEqual(fontRequest, { capabilityId: 'print.font-inspection-embedding', sourceSha256 });
  assert.deepEqual(imageRequest, { capabilityId: 'print.image-resolution-compression', sourceSha256 });
  const input = resultFor(fontRequest.capabilityId);
  const result = validateProfessionalPrintInspectionResult(input, fontRequest);
  input.fonts[0].name = 'Changed';
  assert.equal(result.fonts[0].name, 'Helvetica');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.fonts), true);
  assert.equal(Object.isFrozen(result.fonts[0]), true);
  assert.throws(() => { result.fonts[0].name = 'Changed'; }, TypeError);
  assert.equal(validateProfessionalPrintInspectionResult(resultFor(imageRequest.capabilityId), imageRequest).images[0].xPpi, 300);
});

test('strict result validation rejects identity, count, threshold, and record drift', () => {
  const request = normalizeProfessionalPrintInspectionRequest({ capabilityId: 'print.image-resolution-compression', sourceSha256 });
  const cases = [
    (value) => { value.capabilityId = 'print.font-inspection-embedding'; },
    (value) => { value.sourceSha256 = 'b'.repeat(64); },
    (value) => { value.returnedImageCount = 2; },
    (value) => { value.imageCount = 0; },
    (value) => { value.truncated = true; },
    (value) => { value.belowThreshold = true; },
    (value) => { value.belowThreshold = true; value.belowThresholdCount = 1; },
    (value) => { value.belowThresholdCount = 1; value.unknownResolutionCount = 1; },
    (value) => { value.images[0].bitsPerComponent = 0; },
    (value) => { value.images[0].xPpi = Infinity; },
    (value) => { value.images[0].extra = true; },
  ];
  for (const mutate of cases) {
    const value = resultFor(request.capabilityId);
    mutate(value);
    assert.throws(() => validateProfessionalPrintInspectionResult(value, request), { code: 'INVALID_LOCAL_HOST' });
  }
  const fontRequest = normalizeProfessionalPrintInspectionRequest({ capabilityId: 'print.font-inspection-embedding', sourceSha256 });
  const font = resultFor(fontRequest.capabilityId);
  font.fonts[0].sourceSha256 = 'b'.repeat(64);
  assert.throws(() => validateProfessionalPrintInspectionResult(font, fontRequest), { code: 'INVALID_LOCAL_HOST' });
  const fontCount = resultFor(fontRequest.capabilityId);
  fontCount.fontCount = 0;
  assert.throws(() => validateProfessionalPrintInspectionResult(fontCount, fontRequest), { code: 'INVALID_LOCAL_HOST' });
});

test('strict result validation rejects hostile, accessor, private, malformed, and cyclic values', () => {
  const request = normalizeProfessionalPrintInspectionRequest({ capabilityId: 'print.font-inspection-embedding', sourceSha256 });
  const cases = [
    () => new Proxy(resultFor(request.capabilityId), {}),
    () => {
      const value = resultFor(request.capabilityId);
      Object.defineProperty(value, 'private', { value: true, enumerable: false });
      return value;
    },
    () => {
      const value = resultFor(request.capabilityId);
      Object.defineProperty(value.fonts[0], 'name', { get() { return 'Helvetica'; }, enumerable: true });
      return value;
    },
    () => {
      const value = resultFor(request.capabilityId);
      value.fonts[0].name = new Uint8Array([1]);
      return value;
    },
    () => {
      const value = resultFor(request.capabilityId);
      value.fonts.push(value);
      return value;
    },
    () => {
      const value = resultFor(request.capabilityId);
      Object.defineProperty(value, Symbol('private'), { value: true, enumerable: true });
      return value;
    },
    () => ({ ...resultFor(request.capabilityId), extra: 'x'.repeat(100_001) }),
  ];
  for (const create of cases) assert.throws(() => validateProfessionalPrintInspectionResult(create(), request), { code: 'INVALID_LOCAL_HOST' });
  const maliciousResponse = {};
  Object.defineProperty(maliciousResponse, 'result', { get() { throw new Error('must not read'); }, enumerable: true });
  const endpoints = createProfessionalPrintInspectionEndpoints({ json: async () => maliciousResponse });
  return assert.rejects(endpoints.inspectPrintFonts(documentId, { sourceSha256 }), { code: 'INVALID_LOCAL_HOST' });
});

test('endpoints send exact request bodies and reject malformed requests before transport', async () => {
  const calls = [];
  const endpoints = createProfessionalPrintInspectionEndpoints({
    json: async (path, options) => {
      calls.push({ path, options });
      return { result: resultFor(JSON.parse(options.body).capabilityId) };
    },
  });
  const font = await endpoints.inspectPrintFonts(documentId, { sourceSha256 });
  const image = await endpoints.inspectPrintImages(documentId, { sourceSha256 });
  assert.equal(font.method, 'validated-local-font-inventory');
  assert.equal(image.method, 'validated-local-image-inventory');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, `/api/documents/${documentId}/professional-print-inspection`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { capabilityId: 'print.font-inspection-embedding', sourceSha256 });
  assert.deepEqual(JSON.parse(calls[1].options.body), { capabilityId: 'print.image-resolution-compression', sourceSha256 });
  const accessor = {};
  Object.defineProperty(accessor, 'sourceSha256', { get() { throw new Error('must not read'); }, enumerable: true });
  for (const invalid of [{ sourceSha256: sourceSha256.toUpperCase() }, { sourceSha256, extra: true }, accessor]) {
    assert.throws(() => endpoints.inspectPrintFonts(documentId, invalid));
  }
  assert.equal(calls.length, 2);
});

test('LocalHostClient exposes both print inspection methods and validates before network', async () => {
  const calls = [];
  const client = new LocalHostClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: sourceSha256, engines: [] }));
      return new Response(JSON.stringify({ result: resultFor(JSON.parse(options.body).capabilityId) }));
    },
  });
  await client.bootstrap();
  assert.equal((await client.inspectPrintFonts(documentId, { sourceSha256 })).fontCount, 1);
  assert.equal((await client.inspectPrintImages(documentId, { sourceSha256 })).imageCount, 1);
  assert.equal(calls[1].options.headers['X-Platen-Token'], sourceSha256);
  assert.throws(() => client.inspectPrintFonts(documentId, { sourceSha256: 'invalid' }));
  assert.equal(calls.length, 3);
});
