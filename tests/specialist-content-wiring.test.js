import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleSpecialistContentRoute } from '../scripts/host/routes/specialist-content-routes.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';

const profile = 'local-pdf-specialist-content-v1';
const sourceSha256 = 'a'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';

function result() {
  return {
    profile, sourceSha256, pageCount: 1,
    collection: { present: false, schemaFieldCount: 0, sortFlags: { present: false, descending: false }, viewFlags: { present: false, standard: false } },
    embeddedFiles: { count: 0, aggregateBytes: 0, records: [], truncated: false },
    annotations: { subtypeCounts: { '3D': 0, RichMedia: 0, Screen: 0, Movie: 0, Sound: 0, FileAttachment: 0 }, loci: [], activationCount: 0, actionCount: 0 },
    geospatial: { measureCount: 0, vpCount: 0, lgidictCount: 0, summaries: [] }, associatedFiles: { count: 0, loci: [] }, renditionMedia: { renditionCount: 0, mediaActionCount: 0 },
    evidence: { readOnly: true, payloadBytesReturned: false, namesReturned: false, textReturned: false, pathsReturned: false, objectReferencesReturned: false, aliasCount: 0, cycleChecked: true, bounded: true, sourceDigestReverified: true, sourceUnchangedDuringExtraction: true }, limitations: ['Read-only inventory only; no extraction, playback, scripting, authoring, or safety/conformance claim.', 'Payload bytes, names, text, and filesystem paths are omitted from the privacy-minimal result.', 'Malformed, aliased, cyclic, filtered, or resource-ambiguous specialist content is rejected rather than guessed.'],
  };
}
function routeContext(body) {
  const response = new EventEmitter(); const calls = [];
  return { request: { method: 'POST' }, response, url: new URL('http://local.test/api/documents/doc/specialist-content'), documentId: 'doc', operation: 'specialist-content', processing: { signal: new AbortController().signal }, specialistContentReady: true, specialistContent: { inspect: async (...args) => { calls.push(args); return result(); } }, bodyLimit: 2048, exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (value, expected) => assert.equal(value.method, expected), readJson: async () => body, json: (_response, status, value) => { response.status = status; response.value = value; }, calls };
}
test('specialist-content route accepts exact read-only request and forwards source binding', async () => {
  const value = routeContext({ profile, sourceSha256 }); assert.equal(await handleSpecialistContentRoute(value), true); assert.equal(value.response.status, 200); assert.equal(value.calls[0][1].sourceSha256, sourceSha256);
  await assert.rejects(handleSpecialistContentRoute(routeContext({ profile, sourceSha256, extra: true })), { code: 'PDF_SPECIALIST_CONTENT_OPTIONS_INVALID' });
});
test('bootstrap exposes specialist-content readiness', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response, service: { availability: async () => [] }, specialistContent: { inspect() {} },
    inputs: null, conversion: null, domainFacade: null, prepress: null, aecArtifacts: null, projectBundles: null,
    accessibilityRemediations: null, standardsValidations: null, incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: null, incrementalNamedDestination: null,
    incrementalPageVector: null, pageText: null, fullPageRedaction: null, printerMarks: null, layerDefaults: null, incrementalAccessibilityMetadata: null, javascriptRemoval: null,
    attachmentRemoval: null, annotationFlatten: null, acroFormCheckbox: null, acroFormRadio: null, pdfkitInspections: null, pdfkitOutlineSplits: null, pdfkitMutations: null,
    pdfkitProtection: null, pdfkitSanitization: null, pdfkitTextFieldWidget: null, redactionPlans: null, redactionPlanReports: null, signatureTrustReady: false, signingIdentityReady: false,
    hiddenDataSanitization: null, jpegImage: null, pageLabels: null, advancedSearch: null, pluginSandboxProbeReady: false, token: 'token', method: () => {}, requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; }, sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.specialistContentReady, true);
});
test('local host client posts specialist-content and rejects privacy-contract drift', async () => {
  const token = 'b'.repeat(64); const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 }); return new Response(JSON.stringify({ result: result() }), { status: 200 }); } }); await client.bootstrap(); const value = await client.inspectSpecialistContent(documentId, sourceSha256); assert.equal(value.pageCount, 1); assert.equal(calls[1].path, `/api/documents/${documentId}/specialist-content`); assert.throws(() => client.inspectSpecialistContent(documentId, sourceSha256, { output: 'bad' }), TypeError);
});
test('local host client accepts document-level embedded and associated-file null loci', async () => {
  const documentId = '11111111-1111-4111-8111-111111111111'; const value = result(); value.embeddedFiles = { count: 1, aggregateBytes: 0, records: [{ ordinal: 1, page: null, bytes: 0, sha256: 'a'.repeat(64) }], truncated: false }; value.associatedFiles = { count: 1, loci: [{ ordinal: 1, page: null }] };
  const client = new LocalHostClient({ fetchImpl: async (path) => path === '/api/bootstrap' ? new Response(JSON.stringify({ sessionToken: 'b'.repeat(64) }), { status: 200 }) : new Response(JSON.stringify({ result: value }), { status: 200 }) }); await client.bootstrap(); const accepted = await client.inspectSpecialistContent(documentId, sourceSha256); assert.equal(accepted.embeddedFiles.records[0].page, null); assert.equal(accepted.associatedFiles.loci[0].page, null);
});
