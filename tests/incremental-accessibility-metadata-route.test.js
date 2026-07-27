import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import {
  handleIncrementalAccessibilityMetadataRoute,
} from '../scripts/host/routes/incremental-accessibility-metadata-routes.mjs';

const sourceSha256 = 'a'.repeat(64);
const requestBody = Object.freeze({
  profile: 'local-incremental-document-language-title-v1',
  sourceSha256,
  metadata: { language: 'EN-Latn-US', title: 'Accessible PDF' },
});

function exactJsonObject(value, keys) {
  return Boolean(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function routeFixture({
  body = requestBody,
  url = 'http://local.test/api/documents/document/incremental-accessibility-metadata',
  destroyed = false,
} = {}) {
  const calls = [];
  const deleted = [];
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = destroyed;
  return {
    calls,
    deleted,
    response,
    context: {
      operation: 'incremental-accessibility-metadata',
      request: { method: 'POST' },
      response,
      url: new URL(url),
      documentId: 'document',
      processing: { signal: new AbortController().signal },
      store: { deleteArtifact: async (id) => deleted.push(id) },
      incrementalAccessibilityMetadata: {
        update: async (...args) => {
          calls.push(args);
          return {
            artifact: { id: 'artifact' },
            kind: 'pdf-incremental-accessibility-metadata',
          };
        },
      },
      bodyLimit: 2_048,
      exactJsonObject,
      method: () => {},
      readJson: async (_request, limit) => {
        assert.equal(limit, 2_048);
        return body;
      },
      json: (_response, status, value) => {
        response.status = status;
        response.value = value;
      },
    },
  };
}

test('accessibility metadata route accepts only the fixed source-bound request', async () => {
  const fixture = routeFixture();
  const handled = await handleIncrementalAccessibilityMetadataRoute(fixture.context);
  assert.equal(handled, true);
  assert.equal(fixture.response.status, 201);
  assert.deepEqual(fixture.calls[0].slice(0, 2), [
    'document',
    { language: 'en-latn-us', title: 'Accessible PDF' },
  ]);
  assert.equal(fixture.calls[0][2].sourceSha256, sourceSha256);
});

test('accessibility metadata route rejects query and body drift before service work', async () => {
  const query = routeFixture({
    url: 'http://local.test/api/documents/document/incremental-accessibility-metadata?extra=1',
  });
  await assert.rejects(
    handleIncrementalAccessibilityMetadataRoute(query.context),
    { code: 'INVALID_PARAMETER' },
  );
  assert.equal(query.calls.length, 0);

  const malformed = routeFixture({ body: { ...requestBody, extra: true } });
  await assert.rejects(
    handleIncrementalAccessibilityMetadataRoute(malformed.context),
    { code: 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OPTIONS' },
  );
  assert.equal(malformed.calls.length, 0);
});

test('accessibility metadata route deletes a promoted artifact after disconnect', async () => {
  const fixture = routeFixture({ destroyed: true });
  assert.equal(await handleIncrementalAccessibilityMetadataRoute(fixture.context), true);
  assert.deepEqual(fixture.deleted, ['artifact']);
  assert.equal(fixture.response.status, undefined);
});

test('bootstrap exposes accessibility metadata readiness', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap',
    request: { method: 'GET' },
    response,
    service: { availability: async () => [] },
    inputs: null,
    conversion: null,
    domainFacade: null,
    aecArtifacts: null,
    projectBundles: null,
    accessibilityRemediations: null,
    standardsValidations: null,
    incrementalMetadata: null,
    incrementalBleedBox: null,
    incrementalGoToLink: null,
    incrementalNamedDestination: null,
    incrementalAccessibilityMetadata: {},
    javascriptRemoval: null,
    attachmentRemoval: null,
    annotationFlatten: null,
    pdfkitInspections: null,
    pdfkitOutlineSplits: null,
    pdfkitMutations: null,
    pdfkitProtection: null,
    pdfkitSanitization: null,
    redactionPlans: null,
    redactionPlanReports: null,
    signatureTrustReady: false,
    pluginSandboxProbeReady: false,
    token: 'token',
    method: () => {},
    requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.incrementalAccessibilityMetadataReady, true);
});
