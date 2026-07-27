import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleLayerDefaultsRoute } from '../scripts/host/routes/layer-defaults-routes.mjs';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../scripts/host/pdf-layer-defaults-contract.mjs';

const sourceSha256 = 'a'.repeat(64);
const request = Object.freeze({ profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256, changes: [{ groupIndex: 1, visible: false }] });

function context(body = request, { service = true, aborted = false } = {}) {
  const response = new EventEmitter();
  const controller = new AbortController();
  if (aborted) controller.abort();
  const calls = []; const deleted = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/doc/layer-defaults'),
    documentId: 'doc', operation: 'layer-defaults', processing: { signal: controller.signal },
    layerDefaults: service ? { update: async (...args) => { calls.push(args); return { kind: 'pdf-layer-defaults', artifact: { id: 'artifact-1' } }; } } : null,
    store: { deleteArtifact: async (id) => { deleted.push(id); } }, bodyLimit: 4_096,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected), readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; }, calls, deleted,
  };
}

test('layer-defaults route accepts exact source-bound ordered visibility changes', async () => {
  const value = context();
  assert.equal(await handleLayerDefaultsRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.equal(value.calls[0][0], 'doc');
  assert.deepEqual(value.calls[0][1], request);
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  for (const invalid of [
    { ...request, extra: true },
    { ...request, sourceSha256: sourceSha256.toUpperCase() },
    { ...request, profile: 'custom' },
    { ...request, changes: [{ groupIndex: 1, visible: false }, { groupIndex: 1, visible: true }] },
  ]) await assert.rejects(handleLayerDefaultsRoute(context(invalid)), { code: 'INVALID_PDF_LAYER_DEFAULTS_OPTIONS' });
  await assert.rejects(handleLayerDefaultsRoute(context(request, { service: false })), { code: 'PDF_LAYER_DEFAULTS_UNAVAILABLE' });
});

test('layer-defaults route revokes a promoted artifact after cancellation', async () => {
  const value = context(request, { aborted: true });
  assert.equal(await handleLayerDefaultsRoute(value), true);
  assert.deepEqual(value.deleted, ['artifact-1']);
});

test('bootstrap exposes layer-defaults readiness', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response, service: { availability: async () => [] },
    inputs: null, conversion: null, domainFacade: null, aecArtifacts: null, projectBundles: null,
    accessibilityRemediations: null, standardsValidations: null, incrementalMetadata: null, incrementalBleedBox: null,
    incrementalGoToLink: null, incrementalNamedDestination: null, incrementalPageVector: null, pageText: null,
    fullPageRedaction: null, layerDefaults: {}, incrementalAccessibilityMetadata: null, javascriptRemoval: null,
    attachmentRemoval: null, annotationFlatten: null, pdfkitInspections: null, pdfkitOutlineSplits: null,
    pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null, redactionPlans: null,
    redactionPlanReports: null, signatureTrustReady: false, pluginSandboxProbeReady: false, token: 'token',
    method: () => {}, requireLocalFetchMetadata: () => {}, json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.layerDefaultsReady, true);
});
