import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildPreflightReport } from '../scripts/host/preflight-rules.mjs';
import { handleOutputIntentRoute, handlePrepressRoute } from '../scripts/host/routes/workflow-prepress-route.mjs';
import { createPrepressEndpoints } from '../src/core/local-host-prepress-endpoints.js';

const source = 'a'.repeat(64);
const output = 'b'.repeat(64);
const profileSha = 'c'.repeat(64);
const documentId = '123e4567-e89b-12d3-a456-426614174000';
const artifactId = '123e4567-e89b-42d3-a456-426614174000';
const operationId = '123e4567-e89b-42d3-a456-426614174001';
const createdAt = '2026-08-03T10:00:00.000Z';
const profile = () => ({ id: 'ghostscript-default-cmyk', description: 'Ghostscript bundled default CMYK profile', version: '10.0.0', deviceClass: 'output', colorSpace: 'CMYK', connectionSpace: 'Lab', renderingIntent: 1, size: 512, sha256: profileSha, tagCount: 4 });

function preflightReport(profileId = 'print-review', sha256 = source) {
  return buildPreflightReport({
    profile: profileId,
    document: { sha256 },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' },
    structure: {
      sourceDigest: sha256,
      pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{
        page: 1,
        widthPoints: 612,
        heightPoints: 792,
        boxes: {
          mediaBox: { left: 0, bottom: 0, right: 612, top: 792 },
          bleedBox: { left: 9, bottom: 9, right: 603, top: 783 },
          trimBox: { left: 18, bottom: 18, right: 594, top: 774 },
        },
      }],
      xmpMetadata: { present: true },
    },
    fonts: [],
    images: [],
  });
}
const validators = (kind) => kind === 'cmyk'
  ? ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256']
  : kind === 'imposition'
    ? ['source-sha256', 'uniform-source-page-geometry', 'ghostscript-exit-zero', 'poppler-page-count', 'poppler-sheet-geometry', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256']
    : ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'output-intent-structure', 'closed-classic-rewrite', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256'];

function artifact({ type, parameters, expected, pageCount, kind, validationExtras = {} }) {
  return { id: artifactId, documentId, displayName: 'production-cmyk.pdf', mediaType: 'application/pdf', size: 2048, sha256: output, createdAt,
    operation: { schemaVersion: 1, id: operationId, type, inputs: [{ documentId, sha256: source, role: 'source' }], parameters, expected,
      validation: { passed: true, validators: validators(kind), outputSha256: output, pageCount, textSha256: 'd'.repeat(64), ...validationExtras }, completedAt: createdAt } };
}

function cmykResult() {
  const descriptor = profile(); const pageCount = 2;
  return { kind: 'icc-cmyk-artifact', schemaVersion: 1, sourceDigest: source,
    artifact: artifact({ kind: 'cmyk', type: 'ghostscript-icc-cmyk', pageCount, parameters: { profileId: descriptor.id, profileSha256: profileSha, renderingIntent: 'relative-colorimetric', blackPointCompensation: true, preserveSeparations: true, overrideEmbeddedIcc: false }, expected: { pageCount, outputColorSpace: 'CMYK-targeted', rasterized: false } }),
    profile: descriptor, recipe: { colorConversionStrategy: 'CMYK', renderingIntent: 'relative-colorimetric', blackPointCompensation: true, preservesSeparationAndDeviceN: true, overrideEmbeddedIcc: false, downsampling: false },
    receipt: { engine: { name: 'Ghostscript', version: '10.0.0' }, outputSha256: output, pageCount, pageGeometryPreserved: true, textExtractionEquivalent: true, everyPageRendered: true, outputIntentEmbeddedOrValidated: false, pdfXValidated: false }, authoritative: false,
    limitations: ['This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.', 'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.', 'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.'] };
}

function impositionResult() {
  const layout = { id: '2x1', across: 2, down: 1, order: 'upper-left-row-major', sourcePageCount: 3, sheetCount: 2, sourcePage: { widthPoints: 612, heightPoints: 792, rotation: 0 }, sheet: { widthPoints: 1224, heightPoints: 792 }, marks: 'none' };
  return { kind: 'imposition-artifact', schemaVersion: 1, sourceDigest: source,
    artifact: artifact({ kind: 'imposition', type: 'ghostscript-nup-imposition', pageCount: 2, parameters: { layout: '2x1', across: 2, down: 1, order: 'upper-left-row-major', marks: false }, expected: { pageCount: 2, sheetWidthPoints: 1224, sheetHeightPoints: 792, rasterized: false } }), layout,
    receipt: { engine: { name: 'Ghostscript', version: '10.0.0' }, outputSha256: output, pageCount: 2, vectorOrientedPdfwriteRewrite: true, unconditionalVectorPreservationClaim: false, textExtractionEquivalent: true, everySheetRendered: true, pdfXValidated: false }, authoritative: false,
    limitations: ['This is bounded row-major N-up, not booklet, signature, creep, gutter, step-and-repeat, or production imposition.', 'Printer marks are unavailable because the installed engine has no validated production marks contract.', 'Ghostscript writes a new vector-oriented PDF but may rewrite or rasterize unsupported constructs; links, destinations, tags, annotations, forms, optional content, and signatures are not preserved by contract.'] };
}

function outputIntentResult() {
  const descriptor = profile(); const pageCount = 2;
  return { kind: 'output-intent-artifact', schemaVersion: 1, sourceDigest: source,
    artifact: artifact({ kind: 'output', type: 'ghostscript-cmyk-output-intent', pageCount, validationExtras: { outputIntentCount: 1, profileSha256: profileSha }, parameters: { profileId: descriptor.id, profileSha256: profileSha, profileBytes: descriptor.size, outputIntentSubtype: 'GTS_PDFX', closedClassicRevision: true, priorRevisionsAbsent: true }, expected: { pageCount, outputIntentCount: 1, embeddedProfileSha256: profileSha, pdfXValidated: false } }), profile: descriptor,
    proof: { schema: 'pdf-output-intent-assignment-proof-v1', version: 1, sourceSha256: source, outputSha256: output, profileSha256: profileSha, profileBytes: descriptor.size, sourceObjectCount: 3, outputObjectCount: 5, objectDelta: 2, xrefDelta: 2, outputIntentCount: 1, pageCount, pageTreeNodeCount: 1, pagesTextBoxesRendersUnchangedExpected: true, closedClassicRevision: true, priorRevisionsAbsent: true, limitation: 'Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.', transaction: { profileObjectNumber: 20, outputIntentObjectNumber: 21, appendedXrefOffset: 800 }, compactRewrite: { reachableObjectCount: 5, outputBytes: 2048 } },
    receipt: { outputSha256: output, pageCount, pageGeometryPreserved: true, textExtractionEquivalent: true, everyPageRendered: true, outputIntentCount: 1, pdfXValidated: false }, authoritative: false,
    limitations: ['Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.'] };
}

test('R08 client snapshots only coherent fixed CMYK, imposition, and OutputIntent artifacts', async () => {
  const calls = [];
  const endpoints = createPrepressEndpoints({ json: async (path, options) => { calls.push({ path, options }); const body = JSON.parse(options.body); return { result: body.operation === 'icc-convert' ? cmykResult() : body.operation === 'imposition' ? impositionResult() : outputIntentResult() }; } });
  const cmyk = await endpoints.convertToCmyk(documentId); const imposed = await endpoints.createImposition(documentId, { layout: '2x1', marks: false });
  const outputIntent = await endpoints.assignOutputIntent(documentId, { profile: 'local-ghostscript-default-cmyk-output-intent-v1', sourceSha256: source });
  assert(Object.isFrozen(cmyk) && Object.isFrozen(cmyk.artifact) && Object.isFrozen(cmyk.artifact.operation));
  assert.equal(imposed.layout.id, '2x1'); assert.equal(outputIntent.proof.outputSha256, output);
  assert.equal(calls.length, 3);
});

test('R08 client rejects forged, leaky, drifting, and invalid requests before network delivery', async () => {
  let calls = 0; const endpoints = createPrepressEndpoints({ json: async () => { calls += 1; return { result: cmykResult() }; } });
  assert.throws(() => endpoints.convertToCmyk(documentId, { profile: 'custom' }), TypeError);
  assert.throws(() => endpoints.createImposition(documentId, { layout: '2x1', marks: false, filePath: '/tmp/x' }), TypeError);
  assert.throws(() => endpoints.convertToCmyk('not-an-opaque-id'), TypeError);
  const hostileRequest = new Proxy({ profile: 'local-ghostscript-default-cmyk-output-intent-v1', sourceSha256: source }, { ownKeys() { throw new Error('must not enumerate'); } });
  assert.throws(() => endpoints.assignOutputIntent(documentId, hostileRequest), TypeError);
  assert.equal(calls, 0);
  await endpoints.convertToCmyk(documentId);
  assert.equal(calls, 1);
  const forged = cmykResult(); forged.artifact.filePath = '/private/output.pdf';
  const hostile = createPrepressEndpoints({ json: async () => ({ result: forged }) });
  await assert.rejects(hostile.convertToCmyk(documentId), TypeError);
  const drift = outputIntentResult(); drift.proof.outputSha256 = source;
  const outputEndpoint = createPrepressEndpoints({ json: async () => ({ result: drift }) });
  await assert.rejects(outputEndpoint.assignOutputIntent(documentId, { profile: 'local-ghostscript-default-cmyk-output-intent-v1', sourceSha256: source }), TypeError);
});

test('R08 route exposes a public artifact DTO and revokes undelivered promoted artifacts', async () => {
  const response = new EventEmitter(); response.destroyed = false; const deleted = []; const delivered = [];
  const result = cmykResult(); result.artifact.filePath = '/private/cmyk.pdf'; result.artifact.privateBytes = Buffer.from('PDF');
  await handlePrepressRoute({ request: {}, response, documentId, processing: { signal: new AbortController().signal }, store: { deleteArtifact: async (id) => deleted.push(id) }, prepress: { convertToCmyk: async () => result }, method: () => {}, readJson: async () => ({ operation: 'icc-convert', profile: 'ghostscript-default-cmyk' }), json: (_response, status, body) => delivered.push({ status, body }), parsePositiveInteger: Number });
  assert.equal(delivered[0].status, 200); assert.equal(JSON.stringify(delivered[0]).includes('/private'), false); assert.equal(JSON.stringify(delivered[0]).includes('privateBytes'), false);
  response.emit('close'); await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(deleted, [artifactId]);
});

test('R08 route deletes a promoted artifact when cancellation is observed before response delivery', async () => {
  const controller = new AbortController(); controller.abort(); const deleted = []; const response = new EventEmitter(); response.destroyed = false;
  await handleOutputIntentRoute({ operation: 'prepress/output-intent', request: {}, response, url: new URL('http://localhost/api/documents/x/prepress/output-intent'), documentId, processing: { signal: controller.signal }, store: { deleteArtifact: async (id) => deleted.push(id) }, prepress: { assignOutputIntent: async () => outputIntentResult() }, method: () => {}, readJson: async () => ({ profile: 'local-ghostscript-default-cmyk-output-intent-v1', sourceSha256: source }), json: () => { throw new Error('must not deliver'); } });
  assert.deepEqual(deleted, [artifactId]);
});

test('R08 route revokes an artifact whose public projection is invalid', async () => {
  const deleted = []; const response = new EventEmitter(); response.destroyed = false;
  const result = cmykResult(); result.profile = { bytes: Buffer.from('private') };
  await assert.rejects(handlePrepressRoute({ request: {}, response, documentId, processing: { signal: new AbortController().signal }, store: { deleteArtifact: async (id) => deleted.push(id) }, prepress: { convertToCmyk: async () => result }, method: () => {}, readJson: async () => ({ operation: 'icc-convert', profile: 'ghostscript-default-cmyk' }), json: () => { throw new Error('must not deliver'); }, parsePositiveInteger: Number }), { code: 'INVALID_PREPRESS_RESULT' });
  assert.deepEqual(deleted, [artifactId]);
});

test('R08 route exposes only an exact source-bound fixed-profile preflight report', async () => {
  const delivered = [];
  const calls = [];
  await handlePrepressRoute({
    request: {},
    response: new EventEmitter(),
    documentId,
    processing: { signal: new AbortController().signal },
    store: { getDocument: (id) => (id === documentId ? { id, sha256: source } : null) },
    prepress: {
      runPreflight: async (id, options) => {
        calls.push({ id, options });
        return preflightReport('archive-review');
      },
    },
    method: () => {},
    readJson: async () => ({ operation: 'preflight', profile: 'archive-review' }),
    json: (_response, status, body) => delivered.push({ status, body }),
    parsePositiveInteger: Number,
  });
  assert.equal(delivered[0].status, 200);
  assert.equal(delivered[0].body.result.document.sha256, source);
  assert.deepEqual(calls, [{
    id: documentId,
    options: { profile: 'archive-review', signal: calls[0].options.signal },
  }]);
  assert(calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(delivered[0]).includes('/private'), false);
});

test('R08 route rejects source, profile, and private-surface preflight drift', async () => {
  for (const result of [
    preflightReport('print-review', 'f'.repeat(64)),
    preflightReport('archive-review'),
    { ...preflightReport('print-review'), filePath: '/private/report.json' },
  ]) {
    await assert.rejects(handlePrepressRoute({
      request: {},
      response: new EventEmitter(),
      documentId,
      processing: { signal: new AbortController().signal },
      store: { getDocument: () => ({ id: documentId, sha256: source }) },
      prepress: { runPreflight: async () => result },
      method: () => {},
      readJson: async () => ({ operation: 'preflight', profile: 'print-review' }),
      json: () => { throw new Error('must not deliver'); },
      parsePositiveInteger: Number,
    }), { code: 'INVALID_PREPRESS_RESULT', status: 502 });
  }
});

test('R08 route rejects inherited prepress operation names before service work', async () => {
  let calls = 0;
  for (const operation of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(handlePrepressRoute({
      request: {}, response: new EventEmitter(), documentId,
      processing: { signal: new AbortController().signal }, store: {},
      prepress: { runPreflight: async () => { calls += 1; } }, method: () => {},
      readJson: async () => ({ operation }), json: () => {}, parsePositiveInteger: Number,
    }), { code: 'INVALID_PREPRESS_OPERATION', status: 400 });
  }
  assert.equal(calls, 0);
});
