import test from 'node:test';
import {
  ACCESSIBILITY_REMEDIATION_MEDIA_TYPE,
  assert,
  createHash,
  createOperationProvenance,
  fixture,
  invoke,
  join,
  makeTextPdf,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  PROJECT_BUNDLE_MEDIA_TYPE,
  Readable,
  writeFile,
} from './support/host-router-fixture.js';

test('prepress endpoint reports unavailable service without widening fallback behavior', async (context) => {
  const { handler, store } = await fixture(context, { prepressEnabled: false });
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('PREPRESS')]), displayName: 'prepress.pdf' });
  const response = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/prepress`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' }, body: JSON.stringify({ operation: 'ink-coverage' }),
  });
  assert.equal(response.statusCode, 503); assert.equal(JSON.parse(response.body).error.code, 'PREPRESS_UNAVAILABLE');
});

test('OutputIntent endpoint is authenticated, exact, query-free, and source-bound', async (context) => {
  const { handler, store, prepress } = await fixture(context);
  const document = await store.createDocument({
    stream: Readable.from([makeTextPdf('OUTPUT INTENT')]),
    displayName: 'output-intent.pdf',
  });
  const url = `/api/documents/${document.id}/prepress/output-intent`;
  const headers = {
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };
  const request = {
    profile: 'local-ghostscript-default-cmyk-output-intent-v1',
    sourceSha256: document.sha256,
  };

  const unauthenticated = await invoke(handler, {
    method: 'POST', url,
    headers: { origin: headers.origin, 'content-type': headers['content-type'] },
    body: JSON.stringify(request),
  });
  assert.equal(unauthenticated.statusCode, 401);

  const response = await invoke(handler, {
    method: 'POST', url, headers, body: JSON.stringify(request),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).result.kind, 'output-intent-artifact');
  assert.deepEqual(prepress.outputIntentCalls.map(({ documentId, request: body }) => (
    { documentId, body }
  )), [{ documentId: document.id, body: request }]);
  assert(prepress.outputIntentCalls[0].options.signal instanceof AbortSignal);

  for (const invalid of [
    { url: `${url}?profile=unsafe`, body: request },
    { url, body: { ...request, profile: 'custom' } },
    { url, body: { ...request, unsafe: true } },
  ]) {
    const rejected = await invoke(handler, {
      method: 'POST', url: invalid.url, headers, body: JSON.stringify(invalid.body),
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body).error.code, 'INVALID_OUTPUT_INTENT_REQUEST');
  }
  assert.equal(prepress.outputIntentCalls.length, 1);
});

test('source-bound redaction-plan routes are authenticated, origin-bound, exact, and unavailable only without their service', async (context) => {
  const { handler, store, redactionPlans, redactionPlanReports } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('REDACTION')]), displayName: 'redaction.pdf' });
  const planUrl = `/api/documents/${document.id}/redaction-plan`;
  const applyUrl = `/api/documents/${document.id}/redaction-application`;
  const reportUrl = `/api/documents/${document.id}/redaction-report`;
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' };
  const create = {
    schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: document.sha256,
    expectedWorkspaceRevision: 0, targets: [{ page: 1, fullPage: true }],
  };
  const apply = {
    schemaVersion: 1, profile: 'source-bound-redaction-application-v1', sourceSha256: document.sha256,
    expectedWorkspaceRevision: 1, planId: 'redaction-plan-1', planSha256: 'a'.repeat(64), markIds: ['redaction-mark-1'],
  };
  const report = {
    schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1', sourceSha256: document.sha256,
    expectedWorkspaceRevision: 1, planId: 'redaction-plan-1', planSha256: 'a'.repeat(64),
  };

  const reportUnauthenticated = await invoke(handler, {
    method: 'POST', url: reportUrl,
    headers: { origin: headers.origin, 'content-type': headers['content-type'] },
    body: JSON.stringify(report),
  });
  assert.equal(reportUnauthenticated.statusCode, 401);
  const reportWrongOrigin = await invoke(handler, {
    method: 'POST', url: reportUrl, headers: { ...headers, origin: 'https://attacker.example' },
    body: JSON.stringify(report),
  });
  assert.equal(reportWrongOrigin.statusCode, 403);

  const unauthenticated = await invoke(handler, {
    method: 'POST', url: planUrl, headers: { origin: headers.origin, 'content-type': headers['content-type'] }, body: JSON.stringify(create),
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(JSON.parse(unauthenticated.body).error.code, 'UNAUTHORIZED');
  const wrongOrigin = await invoke(handler, {
    method: 'POST', url: planUrl, headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify(create),
  });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal(JSON.parse(wrongOrigin.body).error.code, 'ORIGIN_FORBIDDEN');

  const created = await invoke(handler, { method: 'POST', url: planUrl, headers, body: JSON.stringify(create) });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(JSON.parse(created.body), { plan: { id: 'redaction-plan-1' }, revision: 1 });
  const applied = await invoke(handler, { method: 'POST', url: applyUrl, headers, body: JSON.stringify(apply) });
  assert.equal(applied.statusCode, 201);
  assert.deepEqual(JSON.parse(applied.body), { artifact: { id: 'redaction-artifact-1' }, application: { status: 'artifact-created' } });
  const reported = await invoke(handler, { method: 'POST', url: reportUrl, headers, body: JSON.stringify(report) });
  assert.equal(reported.statusCode, 200);
  const reportBody = JSON.parse(reported.body);
  assert.equal(reportBody.profile, 'source-bound-redaction-plan-report-v1');
  assert.equal(reportBody.reportStatus, 'proposed-not-applied');
  assert.equal(reportBody.pdfBytesChanged, false);
  assert.deepEqual(redactionPlanReports.calls.map(({ documentId, body }) => ({ documentId, body })), [
    { documentId: document.id, body: report },
  ]);
  assert.deepEqual(redactionPlans.calls.map(({ operation, documentId, body }) => ({ operation, documentId, body })), [
    { operation: 'create', documentId: document.id, body: create },
    { operation: 'apply', documentId: document.id, body: apply },
  ]);

  for (const body of [{ ...apply, geometry: { page: 1, fullPage: true } }, { ...apply, removedText: 'REDACTION' }]) {
    const rejected = await invoke(handler, { method: 'POST', url: applyUrl, headers, body: JSON.stringify(body) });
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body).error.code, 'INVALID_REDACTION_APPLICATION');
  }
  assert.equal(redactionPlans.calls.length, 2);
  assert.deepEqual(redactionPlans.attempts.map(({ body }) => body), [apply, { ...apply, geometry: { page: 1, fullPage: true } }, { ...apply, removedText: 'REDACTION' }]);
  const query = await invoke(handler, { method: 'POST', url: `${reportUrl}?unsafe=1`, headers, body: JSON.stringify(report) });
  assert.equal(query.statusCode, 400);
  assert.equal(JSON.parse(query.body).error.code, 'INVALID_REDACTION_PLAN_REQUEST');

  const unavailable = await fixture(context, { redactionPlansEnabled: false });
  const unavailableDocument = await unavailable.store.createDocument({ stream: Readable.from([makeTextPdf('UNAVAILABLE')]), displayName: 'unavailable.pdf' });
  const response = await invoke(unavailable.handler, {
    method: 'POST', url: `/api/documents/${unavailableDocument.id}/redaction-plan`, headers,
    body: JSON.stringify({ ...create, sourceSha256: unavailableDocument.sha256 }),
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'REDACTION_PLAN_UNAVAILABLE');

  const unavailableReport = await fixture(context, { redactionPlanReportsEnabled: false });
  const reportDocument = await unavailableReport.store.createDocument({ stream: Readable.from([makeTextPdf('REPORT')]), displayName: 'report.pdf' });
  const reportResponse = await invoke(unavailableReport.handler, {
    method: 'POST', url: `/api/documents/${reportDocument.id}/redaction-report`, headers,
    body: JSON.stringify({ ...report, sourceSha256: reportDocument.sha256 }),
  });
  assert.equal(reportResponse.statusCode, 503);
  assert.equal(JSON.parse(reportResponse.body).error.code, 'REDACTION_PLAN_REPORT_UNAVAILABLE');
});

test('OCR routes enforce exact option contracts and forward bounded analysis options', async (context) => {
  const { handler, store } = await fixture(context); const document = await store.createDocument({ stream: Readable.from([makeTextPdf('OCR')]), displayName: 'ocr.pdf' });
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' };
  const legacy = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/ocr`, headers, body: JSON.stringify({}) });
  assert.equal(legacy.statusCode, 201); assert.equal(JSON.parse(legacy.body).result.language, 'eng');
  const unknown = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/ocr`, headers, body: JSON.stringify({ language: 'eng', unsafe: true }) });
  assert.equal(unknown.statusCode, 400); assert.equal(JSON.parse(unknown.body).error.code, 'INVALID_OCR_OPTIONS');
  const valid = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/ocr-analysis`, headers, body: JSON.stringify({ language: 'eng', pages: [1], zones: [{ id: 'zone-1', type: 'text', page: 1, x: 0, y: 0, width: 1, height: 1 }], cleanupPreset: 'none', segmentation: 'block', detectTables: false }) });
  assert.equal(valid.statusCode, 200); assert.equal(JSON.parse(valid.body).result.segmentation, 'block');
  const malformed = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/ocr-analysis`, headers, body: JSON.stringify({ pages: [1], zones: [{ id: 'x', type: 'text', page: 1, x: 0.9, y: 0, width: 0.2, height: 1 }] }) });
  assert.equal(malformed.statusCode, 400); assert.equal(JSON.parse(malformed.body).error.code, 'INVALID_OCR_OPTIONS');
  const batch = await invoke(handler, { method: 'POST', url: '/api/ocr/batch', headers, body: JSON.stringify({ requests: [{ id: 1, documentId: document.id, kind: 'document', options: { language: 'eng' } }] }) });
  assert.equal(batch.statusCode, 200); assert.equal(JSON.parse(batch.body).manifest.requests[0].output.artifact.documentId, document.id);
});

test('bootstrap exposes a session token and sanitized engine availability only to the local host', async (context) => {
  const { handler } = await fixture(context);
  const response = await invoke(handler, { url: '/api/bootstrap' });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.sessionToken, 'test-session-token');
  assert.deepEqual(body.engines, [{ name: 'pdfinfo', version: '26.07.0', available: true, reason: null }]);
  assert.equal(body.host.pdfkitInspectionReady, true);
  assert.equal(body.host.pdfkitMutationReady, true);
  assert.equal(body.host.pdfkitProtectionReady, true);
  assert.equal(body.host.pdfkitSanitizationReady, true);
  assert.equal(body.host.standardsValidationReady, true);
  assert.equal(body.host.redactionPlansReady, true);
  assert.equal(body.host.redactionPlanReportsReady, true);
  assert.equal(body.host.signatureTrustReady, true);
  assert.equal(body.host.pluginSandboxProbeReady, true);
  assert.doesNotMatch(response.body.toString(), /private\/path/);

  const unavailable = await fixture(context, { signatureTrustEnabled: false });
  const unavailableResponse = await invoke(unavailable.handler, { url: '/api/bootstrap' });
  assert.equal(JSON.parse(unavailableResponse.body).host.signatureTrustReady, false);

  const foreignHost = await invoke(handler, { url: '/api/bootstrap', headers: { host: 'attacker.example' } });
  assert.equal(foreignHost.statusCode, 421);

  const crossSite = await invoke(handler, {
    url: '/api/bootstrap', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(JSON.parse(crossSite.body).error.code, 'FETCH_CONTEXT_FORBIDDEN');
});

test('plugin sandbox probe is authenticated, same-origin, POST-only, exact, and optional', async (context) => {
  const { handler, pluginSandboxStatus } = await fixture(context);
  const headers = {
    origin: 'http://127.0.0.1:4173', 'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };
  const url = '/api/plugin-sandbox-probe';
  const unauthenticated = await invoke(handler, { method: 'POST', url, headers: { origin: headers.origin, 'content-type': headers['content-type'] }, body: '{}' });
  assert.equal(unauthenticated.statusCode, 401);
  const foreign = await invoke(handler, { method: 'POST', url, headers: { ...headers, origin: 'https://attacker.example' }, body: '{}' });
  assert.equal(foreign.statusCode, 403);
  const get = await invoke(handler, { method: 'GET', url, headers: { 'x-platen-token': headers['x-platen-token'] } });
  assert.equal(get.statusCode, 405);
  for (const body of ['[]', '{"evidence":true}', '{"plugin":"bytes"}']) {
    const rejected = await invoke(handler, { method: 'POST', url, headers, body });
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body).error.code, 'INVALID_PLUGIN_SANDBOX_PROBE');
  }
  const tooLarge = await invoke(handler, { method: 'POST', url, headers, body: `{${' '.repeat(256)}}` });
  assert.equal(tooLarge.statusCode, 413);
  const response = await invoke(handler, { method: 'POST', url, headers, body: '{}' });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).executionReady, false);
  assert.equal(pluginSandboxStatus.calls, 1);

  const unavailable = await fixture(context, { pluginSandboxProbeEnabled: false });
  const unavailableResponse = await invoke(unavailable.handler, { method: 'POST', url, headers, body: '{}' });
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(JSON.parse(unavailableResponse.body).error.code, 'PLUGIN_SANDBOX_PROBE_UNAVAILABLE');
});

const rasterHeaders = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

async function uploadedRasterFixture(context) {
  const { handler } = await fixture(context);
  const upload = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: { ...rasterHeaders, 'content-type': 'application/pdf' }, body: makeTextPdf(),
  });
  return { handler, documentId: JSON.parse(upload.body).document.id };
}

test('authenticated raster mutation route exposes only explicit local operations', async (context) => {
  const { handler, documentId } = await uploadedRasterFixture(context);
  const mutation = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/mutation`, headers: rasterHeaders,
    body: JSON.stringify({ operation: 'rotate', parameters: { pages: [1], degrees: 90 } }),
  });
  assert.equal(mutation.statusCode, 201);
  assert.deepEqual(JSON.parse(mutation.body).artifact, {
    id: 'raster-rotate', documentId, parameters: { pages: [1], degrees: 90 },
  });

  const rejected = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/mutation`, headers: rasterHeaders,
    body: JSON.stringify({ operation: 'run-shell', parameters: {} }),
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(JSON.parse(rejected.body).error.code, 'INVALID_OPERATION');
});

test('authenticated raster redaction route admits only exact boolean target shapes', async (context) => {
  const { handler, documentId } = await uploadedRasterFixture(context);
  const validFullPageRedaction = {
    operation: 'redact',
    parameters: {
      profile: 'verified-raster-burn-v2', sourceSha256: 'a'.repeat(64), pages: [1],
      redactions: [{ page: 1, fullPage: true, removedText: 'private' }],
    },
  };
  const redaction = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/mutation`, headers: rasterHeaders,
    body: JSON.stringify(validFullPageRedaction),
  });
  assert.equal(redaction.statusCode, 201);
  assert.equal(JSON.parse(redaction.body).artifact.parameters.redactions[0].fullPage, true);
  const spoofedBinding = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/mutation`, headers: rasterHeaders,
    body: JSON.stringify({
      ...validFullPageRedaction,
      parameters: {
        ...validFullPageRedaction.parameters,
        planBinding: { profile: 'source-bound-redaction-plan-v1', planId: 'plan-1', planSha256: 'b'.repeat(64), markIds: ['mark-1'], workspaceRevision: 0, geometryBindingSha256: 'c'.repeat(64) },
      },
    }),
  });
  assert.equal(spoofedBinding.statusCode, 400);
  assert.equal(JSON.parse(spoofedBinding.body).error.code, 'INVALID_PARAMETERS');
  for (const target of [
    { page: 1, fullPage: 'false', removedText: 'private' },
    { page: 1, fullPage: 1, removedText: 'private' },
    { page: 1, fullPage: null, removedText: 'private' },
    { page: 1, fullPage: false, removedText: 'private' },
    { page: 1, fullPage: true, region: { x: 0, y: 0, width: 1, height: 1 }, removedText: 'private' },
    { page: 1, region: { x: 0, y: 0, width: 1, height: 1 }, removedText: 'private', extra: true },
    { page: 1, region: { x: 0, y: 0, width: 1, height: 1, extra: true }, removedText: 'private' },
  ]) {
    const rejected = await invoke(handler, {
      method: 'POST', url: `/api/documents/${documentId}/mutation`, headers: rasterHeaders,
      body: JSON.stringify({
        ...validFullPageRedaction,
        parameters: { ...validFullPageRedaction.parameters, redactions: [target] },
      }),
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body).error.code, 'INVALID_PARAMETERS');
  }
});

test('authenticated comparison routes expose only local comparison modes', async (context) => {
  const { handler, documentId } = await uploadedRasterFixture(context);
  const comparison = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/compare`, headers: rasterHeaders,
    body: JSON.stringify({ secondaryDocumentId: 'secondary', mode: 'pixel', options: { pages: [1], dpi: 96 } }),
  });
  assert.equal(comparison.statusCode, 200);
  const report = JSON.parse(comparison.body).report;
  assert.equal(report.kind, 'pixel');
  assert.equal(report.secondaryDocumentId, 'secondary');
  assert.deepEqual(report.options.pages, [1]);

  const batch = await invoke(handler, {
    method: 'POST', url: '/api/comparisons/batch', headers: rasterHeaders,
    body: JSON.stringify({ mode: 'content', pairs: [{ primaryDocumentId: documentId, secondaryDocumentId: 'secondary' }] }),
  });
  assert.equal(batch.statusCode, 200);
  assert.equal(JSON.parse(batch.body).report.kind, 'batch');

  const rejectedComparison = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/compare`, headers: rasterHeaders,
    body: JSON.stringify({ secondaryDocumentId: 'secondary', mode: 'remote', options: {} }),
  });
  assert.equal(rejectedComparison.statusCode, 400);
  assert.equal(JSON.parse(rejectedComparison.body).error.code, 'UNSUPPORTED_COMPARISON_MODE');
});
