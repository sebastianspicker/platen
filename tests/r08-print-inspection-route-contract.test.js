import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { deliverProfessionalCapability, listProfessionalHandlers } from '../scripts/host/professional-capability/index.mjs';
import { createProfessionalPrintDelivery } from '../scripts/host/professional-capability/standards-preflight-print-core.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { handleDocumentRoutes } from '../scripts/host/router-document-dispatch.mjs';
import { handleProfessionalPrintInspectionRoute } from '../scripts/host/routes/professional-print-inspection-routes.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const FONT_CAPABILITY = 'print.font-inspection-embedding';
const IMAGE_CAPABILITY = 'print.image-resolution-compression';

function fontRecord(sourceSha256, index, embedded = 'yes') {
  return {
    name: `Font ${index}`, type: 'Type 1', encoding: 'WinAnsi', embedded,
    subset: 'no', unicode: 'yes', sourceSha256,
  };
}

function imageRecord(sourceSha256, index, xPpi = 300, yPpi = 300) {
  return {
    page: 1, number: index, type: 'image', width: 600, height: 400,
    color: 'rgb', bitsPerComponent: 8, encoding: 'jpeg', objectId: index + 1,
    generation: 0, xPpi, yPpi, sourceSha256,
  };
}

function validFontResult(sourceSha256) {
  return {
    kind: 'professional-capability-result', schemaVersion: 1, capabilityId: FONT_CAPABILITY,
    ok: true, localOnly: true, sourceSha256, inspected: true, authoritative: false, certified: false,
    limitations: ['Embedding and subsetting are reported from local inspection evidence; no press certification or outline conversion is performed.'],
    method: 'validated-local-font-inventory', fonts: [], fontCount: 0, returnedFontCount: 0,
    truncated: false, missingEmbedCount: 0,
  };
}

async function deliveryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r08-print-inspection-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const document = await store.createDocument({
    stream: Readable.from([createBlankPdf({ pages: 1 })]), displayName: 'source.pdf',
  });
  const signals = [];
  const service = {
    async listFonts(documentId, { signal }) {
      assert.equal(documentId, document.id);
      signals.push(signal);
      return Array.from({ length: 101 }, (_value, index) => fontRecord(document.sha256, index, index === 1 ? 'no' : 'yes'));
    },
    async listImages(documentId, { signal }) {
      assert.equal(documentId, document.id);
      signals.push(signal);
      return Array.from({ length: 101 }, (_value, index) => imageRecord(
        document.sha256, index, index === 0 ? 72 : index === 1 ? null : 300, 300,
      ));
    },
  };
  const professional = createProfessionalPrintDelivery({
    store, services: { service }, deliver: deliverProfessionalCapability, list: listProfessionalHandlers,
  });
  return {
    document, signals,
    professionalCapabilities: Object.freeze({ deliverPrintSourceBound: professional.deliverSourceBound }),
  };
}

function routeFixture({ body, professionalCapabilities, signal = new AbortController().signal, method = 'POST', search = '' }) {
  const request = { method };
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  const documentId = '11111111-1111-4111-8111-111111111111';
  const writes = [];
  return {
    request, response, writes,
    context: {
      operation: 'professional-print-inspection', request, response,
      url: new URL(`http://127.0.0.1/api/documents/${documentId}/professional-print-inspection${search}`),
      documentId, processing: { signal }, professionalCapabilities, bodyLimit: 2_048,
      method: (actual, expected) => assert.equal(actual.method, expected),
      readJson: async () => body,
      json: (_response, status, value) => writes.push({ status, value }),
    },
  };
}

test('professional print delivery returns bounded, source-bound font and image inventories', async (t) => {
  const fixture = await deliveryFixture(t);
  const controller = new AbortController();
  const font = await fixture.professionalCapabilities.deliverPrintSourceBound(FONT_CAPABILITY, {
    documentId: fixture.document.id, sourceSha256: fixture.document.sha256, signal: controller.signal,
  });
  assert.equal(font.kind, 'professional-capability-result');
  assert.equal(font.sourceSha256, fixture.document.sha256);
  assert.equal(font.authoritative, false);
  assert.equal(font.certified, false);
  assert.equal(font.fontCount, 101);
  assert.equal(font.returnedFontCount, 100);
  assert.equal(font.truncated, true);
  assert.equal(font.missingEmbedCount, 1);
  assert.equal(font.limitations.length, 1);

  const image = await fixture.professionalCapabilities.deliverPrintSourceBound(IMAGE_CAPABILITY, {
    documentId: fixture.document.id, sourceSha256: fixture.document.sha256, signal: controller.signal,
  });
  assert.equal(image.imageCount, 101);
  assert.equal(image.returnedImageCount, 100);
  assert.equal(image.truncated, true);
  assert.equal(image.dpiThreshold, 150);
  assert.equal(image.belowThreshold, true);
  assert.equal(image.belowThresholdCount, 1);
  assert.equal(image.unknownResolutionCount, 1);
  assert.equal(image.compressionControlled, false);
  assert.equal(image.limitations.length, 1);
  assert.deepEqual(fixture.signals, [controller.signal, controller.signal]);
});

test('professional print inventory delivery rejects stale or omitted source digests before inspection', async (t) => {
  const fixture = await deliveryFixture(t);
  for (const capabilityId of [FONT_CAPABILITY, IMAGE_CAPABILITY]) {
    for (const sourceSha256 of ['b'.repeat(64), undefined]) {
      await assert.rejects(
        () => fixture.professionalCapabilities.deliverPrintSourceBound(capabilityId, {
          documentId: fixture.document.id,
          ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
        }),
        { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
      );
    }
  }
  assert.deepEqual(fixture.signals, []);
});

test('professional print route forwards an exact source-bound request and publishes only validated evidence', async (t) => {
  const fixture = await deliveryFixture(t);
  const controller = new AbortController();
  const calls = [];
  const routed = routeFixture({
    body: { capabilityId: FONT_CAPABILITY, sourceSha256: fixture.document.sha256 }, signal: controller.signal,
    professionalCapabilities: {
      async deliverPrintSourceBound(...args) {
        calls.push(args);
        return fixture.professionalCapabilities.deliverPrintSourceBound(...args);
      },
    },
  });
  routed.context.documentId = fixture.document.id;
  assert.equal(await handleProfessionalPrintInspectionRoute(routed.context), true);
  assert.equal(routed.writes[0].status, 200);
  assert.deepEqual(calls[0], [FONT_CAPABILITY, {
    documentId: fixture.document.id, sourceSha256: fixture.document.sha256, signal: controller.signal,
  }]);
  assert.equal(routed.writes[0].value.result.fontCount, 101);
  assert.equal(JSON.stringify(routed.writes[0].value).includes(rootPathFragment()), false);
});

test('professional print image route accepts the ordinary Poppler image number zero', async (t) => {
  const fixture = await deliveryFixture(t);
  const routed = routeFixture({
    body: { capabilityId: IMAGE_CAPABILITY, sourceSha256: fixture.document.sha256 },
    professionalCapabilities: fixture.professionalCapabilities,
  });
  routed.context.documentId = fixture.document.id;
  assert.equal(await handleProfessionalPrintInspectionRoute(routed.context), true);
  assert.equal(routed.writes[0].status, 200);
  assert.equal(routed.writes[0].value.result.images[0].number, 0);
  assert.equal(routed.writes[0].value.result.images[0].sourceSha256, fixture.document.sha256);
});

test('professional print route rejects method, query, malformed requests, unavailable services, and invalid results', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const body = { capabilityId: FONT_CAPABILITY, sourceSha256 };
  const unavailable = routeFixture({ body, professionalCapabilities: null });
  await assert.rejects(handleProfessionalPrintInspectionRoute(unavailable.context), { code: 'PROFESSIONAL_PRINT_UNAVAILABLE', status: 503 });
  for (const invalid of [
    { capabilityId: FONT_CAPABILITY },
    { capabilityId: FONT_CAPABILITY, sourceSha256, extra: true },
    { capabilityId: 'print.unknown', sourceSha256 },
    { capabilityId: FONT_CAPABILITY, sourceSha256: sourceSha256.toUpperCase() },
  ]) {
    await assert.rejects(handleProfessionalPrintInspectionRoute(routeFixture({ body: invalid, professionalCapabilities: { async deliverPrintSourceBound() {} } }).context), { code: 'PROFESSIONAL_PRINT_OPTIONS_INVALID', status: 400 });
  }
  await assert.rejects(handleProfessionalPrintInspectionRoute(routeFixture({ body, method: 'GET', professionalCapabilities: {} }).context));
  await assert.rejects(handleProfessionalPrintInspectionRoute(routeFixture({ body, search: '?unsafe=1', professionalCapabilities: {} }).context), { code: 'INVALID_PARAMETER', status: 400 });

  const valid = validFontResult(sourceSha256);
  const hostile = new Proxy(valid, { ownKeys() { throw new Error('hostile result'); } });
  for (const result of [
    { ...valid, privatePath: '/private/tmp/secret.pdf' },
    { ...valid, sourceSha256: 'b'.repeat(64) },
    hostile,
  ]) {
    const routed = routeFixture({ body, professionalCapabilities: { async deliverPrintSourceBound() { return result; } } });
    await assert.rejects(handleProfessionalPrintInspectionRoute(routed.context), { code: 'INVALID_PROFESSIONAL_PRINT_RESULT', status: 502 });
    assert.deepEqual(routed.writes, []);
  }
});

test('application router authenticates and same-origin gates professional print inspection', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const token = 'r08-print-inspection-token';
  const calls = [];
  const handler = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    store: {}, service: {}, workspaceState: {}, token, host: '127.0.0.1', port: 4173,
    professionalCapabilities: {
      async deliverPrintSourceBound(capabilityId, context) {
        calls.push({ capabilityId, context });
        return validFontResult(sourceSha256);
      },
    },
  });
  const path = '/api/documents/document-id/professional-print-inspection';
  const body = JSON.stringify({ capabilityId: FONT_CAPABILITY, sourceSha256 });
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
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.capabilityId, FONT_CAPABILITY);
  assert.equal(calls.length, 1);
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
    body: JSON.stringify({ capabilityId: FONT_CAPABILITY, sourceSha256, padding: 'x'.repeat(2_048) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(calls.length, 1);
});

test('professional print route preserves cancellation and the document dispatcher admits the exact operation', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const cancelled = new AbortController();
  cancelled.abort();
  const routed = routeFixture({
    body: { capabilityId: FONT_CAPABILITY, sourceSha256 }, signal: cancelled.signal,
    professionalCapabilities: { async deliverPrintSourceBound(_capabilityId, { signal }) {
      assert.equal(signal, cancelled.signal);
      throw new HostError('JOB_CANCELLED', 'cancelled', 499);
    } },
  });
  await assert.rejects(handleProfessionalPrintInspectionRoute(routed.context), { code: 'JOB_CANCELLED', status: 499 });

  let observed = null;
  const routes = new Proxy({}, { get(_target, property) {
    if (property === 'workspace') return async () => false;
    if (property === 'workflow') return async (context) => { observed = context; return true; };
    return async () => false;
  } });
  assert.equal(await handleDocumentRoutes({
    pathname: '/api/documents/document-id/professional-print-inspection', request: {}, response: {},
    url: new URL('http://127.0.0.1/api/documents/document-id/professional-print-inspection'),
    processing: { signal: new AbortController().signal }, store: {}, workspaceState: {}, routes,
    limits: { professionalPrintInspection: 2_048 }, professionalCapabilities: { deliverPrintSourceBound() {} },
  }), true);
  assert.equal(observed.operation, 'professional-print-inspection');
  assert.equal(observed.professionalCapabilities.deliverPrintSourceBound instanceof Function, true);
});

function rootPathFragment() {
  return '/Users/sebastian/Git/platen';
}
