import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleSpecialistContentRoute } from '../scripts/host/routes/specialist-content-routes.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createSpecialistContentEndpoints } from '../src/core/local-host-specialist-content-endpoints.js';

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
function inspectResult(payload) {
  return createSpecialistContentEndpoints({ json: async () => ({ result: payload }) }).inspectSpecialistContent(documentId, sourceSha256);
}
function mutateResult(mutate) {
  const payload = structuredClone(result()); mutate(payload); return payload;
}
function assertFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) if (child && typeof child === 'object') assertFrozen(child);
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
test('specialist-content endpoint accepts and recursively freezes the complete privacy-minimal result', async () => {
  const accepted = await inspectResult(result());
  assert.deepEqual(accepted, result()); assertFrozen(accepted);
});
test('specialist-content endpoint rejects drift in every validation section', async () => {
  const cases = [
    ['root profile', (payload) => { payload.profile = 'other'; }],
    ['source binding', (payload) => { payload.sourceSha256 = 'b'.repeat(64); }],
    ['limitations privacy statement', (payload) => { payload.limitations[0] = 'payload leaked'; }],
    ['collection flags', (payload) => { payload.collection.sortFlags = { present: false, standard: false }; }],
    ['embedded record range', (payload) => { payload.embeddedFiles = { count: 1, aggregateBytes: 0, records: [{ ordinal: 1, page: 2, bytes: 0, sha256: sourceSha256 }], truncated: false }; }],
    ['annotation subtype density', (payload) => { payload.annotations = { ...payload.annotations, subtypeCounts: { ...payload.annotations.subtypeCounts, Movie: 1 } }; }],
    ['geospatial unit', (payload) => { payload.geospatial = { ...payload.geospatial, measureCount: 1, summaries: [{ kind: 'measure', unit: 'px', digest: sourceSha256 }] }; }],
    ['associated ordinal', (payload) => { payload.associatedFiles = { count: 1, loci: [{ ordinal: 2, page: null }] }; }],
    ['rendition range', (payload) => { payload.renditionMedia.mediaActionCount = 50_001; }],
    ['evidence privacy flag', (payload) => { payload.evidence.textReturned = true; }],
  ];
  for (const [name, mutate] of cases) await assert.rejects(inspectResult(mutateResult(mutate)), TypeError, name);
});
test('specialist-content endpoint rejects sparse arrays, accessors, and non-data descriptors before their values are read', async () => {
  const sparse = mutateResult((payload) => { payload.embeddedFiles = { count: 1, aggregateBytes: 0, records: new Array(1), truncated: false }; });
  await assert.rejects(inspectResult(sparse), TypeError);
  const accessor = result(); let accessorReads = 0;
  Object.defineProperty(accessor, 'profile', { configurable: true, enumerable: true, get() { accessorReads += 1; return profile; } });
  await assert.rejects(inspectResult(accessor), TypeError); assert.equal(accessorReads, 0);
  const descriptorProxy = new Proxy(result(), { get(_target, key) { if (key === 'profile') throw new Error('profile should not be read'); return Reflect.get(_target, key); }, getOwnPropertyDescriptor(target, key) { if (key === 'profile') return { configurable: true, enumerable: true, get() { return profile; } }; return Reflect.getOwnPropertyDescriptor(target, key); } });
  await assert.rejects(inspectResult(descriptorProxy), TypeError);
});
test('specialist-content endpoint retains stateful proxy read order for root and nested flags', async () => {
  const root = result(); let pageReads = 0;
  const statefulRoot = new Proxy(root, { get(target, key) { if (key === 'pageCount') return pageReads++ === 0 ? target.pageCount : 0; return Reflect.get(target, key); } });
  await assert.rejects(inspectResult(statefulRoot), TypeError); assert.equal(pageReads, 2);
  const nested = result(); let sortReads = 0;
  nested.collection = new Proxy(nested.collection, { get(target, key) { if (key === 'sortFlags') return sortReads++ === 0 ? target.sortFlags : target.viewFlags; return Reflect.get(target, key); } });
  await assert.rejects(inspectResult(nested), TypeError); assert.equal(sortReads, 2);
});
test('specialist-content endpoint rejects each remaining validator field, bound, and nested shape', async () => {
  const cases = [
    ['root shape', (p) => { p.extra = true; }], ['page count lower bound', (p) => { p.pageCount = 0; }], ['page count integer', (p) => { p.pageCount = 1.5; }], ['page count upper bound', (p) => { p.pageCount = 1_001; }], ['limitations density', (p) => { p.limitations = new Array(3); }],
    ['collection shape', (p) => { p.collection.extra = true; }], ['collection present type', (p) => { p.collection.present = 0; }], ['collection schema bound', (p) => { p.collection.schemaFieldCount = 10_001; }], ['sort flag present type', (p) => { p.collection.sortFlags.present = 0; }], ['sort flag value type', (p) => { p.collection.sortFlags.descending = 0; }], ['view flag present type', (p) => { p.collection.viewFlags.present = 0; }], ['view flag value type', (p) => { p.collection.viewFlags.standard = 0; }],
    ['embedded count bound', (p) => { p.embeddedFiles.count = 4_001; }], ['embedded aggregate bound', (p) => { p.embeddedFiles.aggregateBytes = 64 * 1024 * 1024 + 1; }], ['embedded count density', (p) => { p.embeddedFiles.count = 1; }], ['embedded truncated type', (p) => { p.embeddedFiles.truncated = 0; }],
    ['embedded record shape', (p) => { p.embeddedFiles = { count: 1, aggregateBytes: 0, records: [{ ordinal: 1, page: null, bytes: 0, sha256: sourceSha256, extra: true }], truncated: false }; }], ['embedded record ordinal', (p) => { p.embeddedFiles = { count: 1, aggregateBytes: 0, records: [{ ordinal: 0, page: null, bytes: 0, sha256: sourceSha256 }], truncated: false }; }], ['embedded record bytes bound', (p) => { p.embeddedFiles = { count: 1, aggregateBytes: 64 * 1024 * 1024 + 1, records: [{ ordinal: 1, page: null, bytes: 64 * 1024 * 1024 + 1, sha256: sourceSha256 }], truncated: false }; }], ['embedded record SHA', (p) => { p.embeddedFiles = { count: 1, aggregateBytes: 0, records: [{ ordinal: 1, page: null, bytes: 0, sha256: 'bad' }], truncated: false }; }], ['embedded aggregate reconciliation', (p) => { p.embeddedFiles = { count: 1, aggregateBytes: 1, records: [{ ordinal: 1, page: null, bytes: 0, sha256: sourceSha256 }], truncated: false }; }],
    ['annotation shape', (p) => { p.annotations.extra = true; }],
    ['annotation subtype-count shape', (p) => { p.annotations.subtypeCounts.extra = 0; }],
    ['annotation subtype count bound', (p) => { p.annotations.subtypeCounts.Movie = 50_001; }],
    ['annotation activation bound', (p) => { p.annotations.activationCount = 50_001; }],
    ['annotation action bound', (p) => { p.annotations.actionCount = 50_001; }],
    ['annotation loci density', (p) => { p.annotations.loci = new Array(1); }],
    ['annotation locus shape', (p) => { p.annotations = { ...p.annotations, loci: [{ page: 1, subtype: 'Movie', extra: true }], subtypeCounts: { ...p.annotations.subtypeCounts, Movie: 1 } }; }],
    ['annotation locus lower page bound', (p) => { p.annotations = { ...p.annotations, loci: [{ page: 0, subtype: 'Movie' }], subtypeCounts: { ...p.annotations.subtypeCounts, Movie: 1 } }; }],
    ['annotation subtype', (p) => { p.annotations = { ...p.annotations, loci: [{ page: 1, subtype: 'Link' }], subtypeCounts: { ...p.annotations.subtypeCounts, Movie: 1 } }; }],
    ['geospatial shape', (p) => { p.geospatial.extra = true; }], ['geospatial measure bound', (p) => { p.geospatial.measureCount = 4_001; }], ['geospatial VP bound', (p) => { p.geospatial.vpCount = 4_001; }], ['geospatial LGIDict bound', (p) => { p.geospatial.lgidictCount = 4_001; }], ['geospatial summary density', (p) => { p.geospatial.measureCount = 1; }], ['geospatial summaries density', (p) => { p.geospatial = { ...p.geospatial, measureCount: 1, summaries: new Array(1) }; }], ['geospatial summary shape', (p) => { p.geospatial = { ...p.geospatial, measureCount: 1, summaries: [{ kind: 'measure', unit: null, digest: sourceSha256, extra: true }] }; }], ['geospatial kind', (p) => { p.geospatial = { ...p.geospatial, measureCount: 1, summaries: [{ kind: 'VP', unit: null, digest: sourceSha256 }] }; }], ['geospatial digest', (p) => { p.geospatial = { ...p.geospatial, measureCount: 1, summaries: [{ kind: 'measure', unit: null, digest: 'bad' }] }; }],
    ['associated shape', (p) => { p.associatedFiles.extra = true; }], ['associated count bound', (p) => { p.associatedFiles.count = 50_001; }], ['associated count density', (p) => { p.associatedFiles.count = 1; }], ['associated loci density', (p) => { p.associatedFiles = { count: 1, loci: new Array(1) }; }], ['associated locus shape', (p) => { p.associatedFiles = { count: 1, loci: [{ ordinal: 1, page: null, extra: true }] }; }], ['associated page bound', (p) => { p.associatedFiles = { count: 1, loci: [{ ordinal: 1, page: 2 }] }; }],
    ['rendition shape', (p) => { p.renditionMedia.extra = true; }], ['rendition count bound', (p) => { p.renditionMedia.renditionCount = 50_001; }],
    ['evidence shape', (p) => { p.evidence.extra = true; }], ['evidence alias bound', (p) => { p.evidence.aliasCount = 50_001; }], ['evidence alias integer', (p) => { p.evidence.aliasCount = 0.5; }],
  ];
  for (const [name, mutate] of cases) await assert.rejects(inspectResult(mutateResult(mutate)), TypeError, name);
});
test('specialist-content endpoint rejects every evidence privacy and source-integrity flag independently', async () => {
  const expectations = [['readOnly', false], ['payloadBytesReturned', true], ['namesReturned', true], ['textReturned', true], ['pathsReturned', true], ['objectReferencesReturned', true], ['cycleChecked', false], ['bounded', false], ['sourceDigestReverified', false], ['sourceUnchangedDuringExtraction', false]];
  for (const [key, invalidValue] of expectations) await assert.rejects(inspectResult(mutateResult((payload) => { payload.evidence[key] = invalidValue; })), TypeError, key);
  for (const [key] of expectations) await assert.rejects(inspectResult(mutateResult((payload) => { payload.evidence[key] = 'invalid'; })), TypeError, `${key} type`);
});
