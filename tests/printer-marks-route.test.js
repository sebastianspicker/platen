import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handlePrinterMarksRoute } from '../scripts/host/routes/printer-marks-routes.mjs';

const sourceSha256 = 'a'.repeat(64);
function context(body) {
  const response = new EventEmitter(); response.writableEnded = false;
  const calls = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/doc/printer-marks'),
    documentId: 'doc', operation: 'printer-marks',
    processing: { signal: new AbortController().signal },
    printerMarks: { create: async (...args) => { calls.push(args); return {
      kind: 'pdf-printer-marks', sourceDigest: sourceSha256,
      artifact: {
        id: 'artifact', documentId: 'doc', displayName: 'printer-marks.pdf',
        mediaType: 'application/pdf', size: 128, sha256: 'b'.repeat(64),
        operation: { type: 'pdf-printer-marks' }, createdAt: '2026-08-03T00:00:00.000Z',
        filePath: '/private/artifacts/printer-marks.pdf',
      },
      pages: [], evidence: { localOnly: true }, limitations: ['bounded'],
    }; } },
    bodyLimit: 4096,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; }, calls,
  };
}

test('printer-marks route authenticates exact request and forwards pages once', async () => {
  const body = { profile: 'local-pdf-printer-marks-v1', sourceSha256, pages: [1, 3, 5] };
  const value = context(body);
  assert.equal(await handlePrinterMarksRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0][1], body);
  assert.equal(Object.hasOwn(value.response.value.result.artifact, 'filePath'), false);
  for (const invalid of [{ ...body, pages: [3, 1] }, { ...body, pages: [1, 1] }, { ...body, extra: true }]) {
    await assert.rejects(handlePrinterMarksRoute(context(invalid)), { code: 'PRINTER_MARKS_OPTIONS_INVALID' });
  }
});

test('bootstrap exposes printer-marks readiness', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response,
    service: { availability: async () => [] }, inputs: null, conversion: null,
    domainFacade: null, prepress: null, aecArtifacts: null, projectBundles: null,
    accessibilityRemediations: null, standardsValidations: null,
    incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: null,
    incrementalNamedDestination: null, incrementalPageVector: null, pageText: null,
    fullPageRedaction: null, printerMarks: { create() {} }, layerDefaults: null,
    incrementalAccessibilityMetadata: null, javascriptRemoval: null,
    attachmentRemoval: null, annotationFlatten: null, acroFormCheckbox: null,
    acroFormRadio: null, pdfkitInspections: null, pdfkitOutlineSplits: null,
    pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null,
    pdfkitTextFieldWidget: null, redactionPlans: null, redactionPlanReports: null,
    signatureTrustReady: false, signingIdentityReady: false,
    hiddenDataSanitization: null, jpegImage: null, pageLabels: null,
    advancedSearch: null, pluginSandboxProbeReady: false, token: 'token', method: () => {},
    requireLocalFetchMetadata: () => {}, json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.printerMarksReady, true);
});
