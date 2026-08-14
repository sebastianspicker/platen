import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  aecCalibrationResult,
  aecMeasurementResult,
  aecSourceBinding,
  assert,
  LocalHostClient,
  metadataSanitizationResult,
  ocrDocumentResult,
  ocrLayoutResult,
  protectionRemovalResult,
  token,
} from './support/local-host-client-fixture.js';

function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
const canonicalDigest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

test('local host client normalizes source-bound AEC requests and validates native materialization receipts', async () => {
  const calls = [];
  const calibration = aecCalibrationResult(); const measurement = aecMeasurementResult();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (path.endsWith('/aec-calibration')) return new Response(JSON.stringify({ result: calibration }), { status: 201 });
    if (path.endsWith('/aec-measurement')) return new Response(JSON.stringify({ result: measurement }), { status: 201 });
    if (path.endsWith('/aec-materialization')) return new Response(JSON.stringify({ result: {
      kind: 'pdf-native-aec-measurement', schemaVersion: 2, sourceDigest: 'b'.repeat(64),
      measurement: measurement.measurement,
      artifact: { id: 'artifact-1', sha256: 'e'.repeat(64) },
      nativeReceipt: {
        schema: 'pdfkit-aec-measurement-receipt-v1', version: 1, operation: 'applyAecMeasurement',
        sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64), measurementId: 'measurement-1',
        page: 1, kind: 'distance', quantity: 0.3048, unit: 'm', calibrationId: 'calibration-1',
        annotationCount: 1, annotationSubtypes: ['line'], measurementDictionaryEmbedded: false, pageCount: 1,
      },
      receipt: {
        schema: 'platen-aec-materialization-receipt-v2', version: 2, operation: 'applyAecMeasurement',
        sourceSha256: 'c'.repeat(64), outputSha256: 'e'.repeat(64), measurementId: 'measurement-1',
        page: 1, kind: 'distance', quantity: 0.3048, unit: 'm', calibrationId: 'calibration-1',
        annotationCount: 1, annotationSubtypes: ['line'], measurementDictionaryEmbedded: true,
        measurementDictionaryScope: 'line-and-page-viewport', sourcePrefixPreserved: true,
        rootPreserved: true, infoPreserved: true, catalogVersionRaised: true,
        idPolicy: 'preserved', pageCount: 1,
      },
      evidence: { localOnly: true, sourceBound: true, nativeAnnotations: true, helperReopened: true, popplerParsed: true, allPagesRendered: true, sourceUnchanged: true },
      limitations: ['Bounded ISO/PDF Measure dictionary subset.'],
    } }), { status: 201 });
    throw new Error(`unexpected path ${path}`);
  } });
  await client.bootstrap();
  const calibrationRequest = {
    schemaVersion: 1, sourceSha256: 'b'.repeat(64), expectedRevision: 0, id: 'calibration-1', page: 1,
    points: [{ x: 0, y: 0 }, { x: 72, y: 0 }], realLength: 1, unit: 'ft', label: 'Plan scale',
  };
  const measurementRequest = {
    schemaVersion: 1, sourceSha256: 'b'.repeat(64), expectedRevision: 1, id: 'measurement-1', page: 1,
    kind: 'distance', points: [{ x: 0, y: 0 }, { x: 72, y: 0 }], calibrationId: 'calibration-1', label: 'Wall', displayUnit: 'ft',
  };
  assert.equal((await client.calibrateAec('doc', calibrationRequest)).calibration.id, 'calibration-1');
  assert.equal((await client.measureAec('doc', measurementRequest)).measurement.result.displayValue, 1);
  assert.equal((await client.materializeAec('doc', {
    schemaVersion: 1, sourceSha256: 'b'.repeat(64), expectedRevision: 2, measurementId: 'measurement-1',
  })).artifact.id, 'artifact-1');
  assert.deepEqual(calls.slice(1).map(({ path }) => path), [
    '/api/documents/doc/aec-calibration', '/api/documents/doc/aec-measurement', '/api/documents/doc/aec-materialization',
  ]);
  assert.throws(() => client.measureAec('doc', { ...measurementRequest, displayUnit: 'ft2' }), TypeError);
  assert.throws(() => client.materializeAec('doc', { schemaVersion: 1, sourceSha256: 'B'.repeat(64), expectedRevision: 2, measurementId: 'measurement-1' }), TypeError);
});

test('local host client exports and revision-guards canonical project bundles', async () => {
  const calls = [];
  const bundle = '{"payloadSha256":"' + 'b'.repeat(64) + '","schemaVersion":1,"sourcePdfSha256":"' + 'a'.repeat(64) + '","workspace":{"audit":[],"namespaces":{},"revision":0}}';
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (options.method === 'POST') return new Response(JSON.stringify({ workspace: { revision: 3 } }), { status: 200 });
    return new Response(bundle, { status: 200, headers: { 'content-type': 'application/vnd.platen.project+json' } });
  } });
  await client.bootstrap();
  assert.equal(await client.exportProjectBundle('doc'), bundle);
  assert.deepEqual(await client.importProjectBundle('doc', bundle, 2), { revision: 3 });
  assert.equal(calls[1].path, '/api/documents/doc/project-bundle');
  assert.equal(calls[2].path, '/api/documents/doc/project-bundle?expectedRevision=2');
  assert.equal(calls[2].options.headers['Content-Type'], 'application/vnd.platen.project+json');
  assert.equal(calls[2].options.body, bundle);
  assert.throws(() => client.importProjectBundle('doc', bundle, -1), TypeError);
  assert.throws(() => client.importProjectBundle('doc', 'x'.repeat(600 * 1024 + 1), 2), TypeError);
});

test('local host client streams self-contained portable project blobs through fixed media types', async () => {
  const calls = [];
  const portable = new Blob(['PLATENPROJECT\0\u0001\r\nfixture'], { type: 'application/vnd.platen.portable-project' });
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (path.endsWith('/portable-project-bundle')) return new Response(portable, { status: 200, headers: { 'content-type': portable.type } });
    if (path === '/api/project-bundles') return new Response(JSON.stringify({ result: { document: { id: 'imported' }, workspace: { revision: 1 } } }), { status: 201 });
    throw new Error(`unexpected path ${path}`);
  } });
  await client.bootstrap();
  assert.equal((await client.exportPortableProjectBundle('doc')).size, portable.size);
  assert.equal((await client.importPortableProjectBundle(portable)).document.id, 'imported');
  assert.equal(calls[1].path, '/api/documents/doc/portable-project-bundle');
  assert.equal(calls[2].path, '/api/project-bundles');
  assert.equal(calls[2].options.headers['Content-Type'], 'application/vnd.platen.portable-project');
  assert.equal(calls[2].options.body, portable);
  assert.throws(() => client.importPortableProjectBundle(new Blob([])), TypeError);
});

test('local host client exposes raster mutation and local comparison requests', async () => {
  const calls = [];
  const primaryDocumentId = '11111111-1111-4111-8111-111111111111';
  const secondaryDocumentId = '22222222-2222-4222-8222-222222222222';
  const contentReport = (primary = primaryDocumentId, secondary = secondaryDocumentId) => ({
    kind: 'content',
    inputs: [
      { documentId: primary, sha256: 'a'.repeat(64), role: 'primary' },
      { documentId: secondary, sha256: 'b'.repeat(64), role: 'secondary' },
    ],
    stats: { added: 0, deleted: 0, unchanged: 1, changed: 0, leftPages: 1, rightPages: 1 },
    pages: [{
      page: 1, leftPresent: true, rightPresent: true,
      runs: [{ kind: 'unchanged', text: 'same', count: 1 }],
      stats: { added: 0, deleted: 0, unchanged: 1 },
    }],
  });
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (path === '/api/comparisons/batch') return new Response(JSON.stringify({ report: { kind: 'batch', mode: 'content', reports: [contentReport()] } }), { status: 200 });
    if (path.endsWith('/mutation')) return new Response(JSON.stringify({ artifact: { id: 'raster' } }), { status: 201 });
    if (path.endsWith('/compare')) return new Response(JSON.stringify({ report: contentReport() }), { status: 200 });
    throw new Error(`unexpected path ${path}`);
  } });
  await client.bootstrap();

  assert.deepEqual(await client.mutateRaster('doc', 'rotate', { degrees: 90 }), { id: 'raster' });
  const redaction = {
    profile: 'verified-raster-burn-v2', sourceSha256: 'a'.repeat(64), pages: [1],
    redactions: [{ page: 1, fullPage: true, removedText: 'private' }],
  };
  assert.deepEqual(await client.mutateRaster('doc', 'redact', redaction), { id: 'raster' });
  for (const fullPage of ['false', 1, null, false]) {
    assert.throws(() => client.mutateRaster('doc', 'redact', {
      ...redaction, redactions: [{ page: 1, fullPage, removedText: 'private' }],
    }), TypeError);
  }
  assert.throws(() => client.mutateRaster('doc', 'redact', {
    ...redaction,
    redactions: [{ page: 1, fullPage: true, region: { x: 0, y: 0, width: 1, height: 1 }, removedText: 'private' }],
  }), TypeError);
  assert.throws(() => client.mutateRaster('doc', 'redact', {
    ...redaction,
    redactions: [{ page: 1, region: { x: 0, y: 0, width: 1, height: 1 }, removedText: 'private', extra: true }],
  }), TypeError);
  assert.equal((await client.compareDocuments(primaryDocumentId, secondaryDocumentId, 'content')).kind, 'content');
  assert.equal((await client.compareBatch([{ primaryDocumentId, secondaryDocumentId }])).kind, 'batch');

  assert.deepEqual(calls.slice(1).map(({ path }) => path), [
    '/api/documents/doc/mutation', '/api/documents/doc/mutation',
    `/api/documents/${primaryDocumentId}/compare`, '/api/comparisons/batch',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { operation: 'rotate', parameters: { degrees: 90 } });
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    secondaryDocumentId, mode: 'content', options: {},
  });
  assert.equal(calls.slice(1).every(({ options }) => options.headers['X-Platen-Token'] === token), true);
});

test('local host client creates and applies source-bound redaction plans without sending text', async () => {
  const calls = [];
  let tamperReport = false;
  const sourceSha256 = 'a'.repeat(64);
  const plan = {
    id: 'plan-1', type: 'redaction-plan', schemaVersion: 1,
    profile: 'source-bound-redaction-plan-v1', status: 'proposed-not-applied',
    createdAtLocal: '2026-07-19T10:00:00.000Z',
    sourceSha256, coordinateSpace: 'normalized-cropbox-top-left-v1',
    marks: [{ id: 'mark-1', page: 1, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
    applicationProfile: 'verified-raster-burn-v2', planSha256: 'b'.repeat(64),
  };
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (path.endsWith('/redaction-plan')) return new Response(JSON.stringify({ plan, revision: 1 }), { status: 201 });
    if (path.endsWith('/redaction-application')) return new Response(JSON.stringify({
      artifact: { id: 'artifact-plan', sha256: 'c'.repeat(64) },
      application: {
        status: 'artifact-created',
        planStatus: 'proposed-not-applied',
        textEvidence: 'validated-transiently-not-retained',
      },
    }), { status: 201 });
    if (path.endsWith('/redaction-report')) {
      const report = {
        schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1',
        sourceSha256, workspaceRevision: 1, planId: plan.id, planSha256: plan.planSha256,
        planCreatedAtLocal: plan.createdAtLocal,
        coordinateSpace: plan.coordinateSpace, applicationProfile: plan.applicationProfile,
        marks: plan.marks, reportStatus: 'proposed-not-applied', pdfBytesChanged: false,
      };
      const responseReport = { ...report, reportSha256: canonicalDigest(report) };
      if (tamperReport) responseReport.marks = [{
        ...report.marks[0], region: { ...report.marks[0].region, x: 0.2 },
      }];
      return new Response(JSON.stringify(responseReport), { status: 200 });
    }
    throw new Error(`unexpected path ${path}`);
  } });
  await client.bootstrap();
  const created = await client.createRedactionPlan('doc', {
    sourceSha256, expectedWorkspaceRevision: 0,
    targets: [{ page: 1, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
  });
  const applied = await client.applyRedactionPlan('doc', {
    sourceSha256, expectedWorkspaceRevision: created.revision,
    planId: plan.id, planSha256: plan.planSha256, markIds: ['mark-1'],
  });
  const report = await client.exportRedactionPlanReport('doc', {
    sourceSha256, expectedWorkspaceRevision: created.revision,
    planId: plan.id, planSha256: plan.planSha256,
  });
  assert.equal(applied.artifact.id, 'artifact-plan');
  assert.equal(report.reportStatus, 'proposed-not-applied');
  assert.equal(report.pdfBytesChanged, false);
  assert.deepEqual(calls.slice(1).map(({ path }) => path), [
    '/api/documents/doc/redaction-plan',
    '/api/documents/doc/redaction-application',
    '/api/documents/doc/redaction-report',
  ]);
  const applicationBody = JSON.parse(calls[2].options.body);
  assert.equal('targets' in applicationBody, false);
  assert.equal('region' in applicationBody, false);
  assert.equal('removedText' in applicationBody, false);
  assert.deepEqual(applicationBody.markIds, ['mark-1']);
  const reportBody = JSON.parse(calls[3].options.body);
  assert.deepEqual(Object.keys(reportBody), [
    'schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision',
    'planId', 'planSha256',
  ]);
  assert.equal(JSON.stringify(reportBody).includes('region'), false);
  assert.equal(JSON.stringify(report).includes('textBinding'), false);
  tamperReport = true;
  await assert.rejects(client.exportRedactionPlanReport('doc', {
    sourceSha256, expectedWorkspaceRevision: created.revision,
    planId: plan.id, planSha256: plan.planSha256,
  }), /invalid canonical digest/u);
});
