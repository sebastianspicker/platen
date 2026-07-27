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

test('outline split route requires auth, exact body, and an available helper', async (context) => {
  const { handler, pdfkitOutlineSplits } = await fixture(context);
  const path = '/api/documents/11111111-1111-4111-8111-111111111111/split-outline';
  let response = await invoke(handler, { method: 'POST', url: path, headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: '{"profile":"macos-pdfkit-top-level-outline-split-v1"}' });
  assert.equal(response.statusCode, 401);
  response = await invoke(handler, { method: 'POST', url: path, headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': 'test-session-token', 'content-type': 'application/json' }, body: '{"profile":"wrong","extra":true}' });
  assert.equal(response.statusCode, 400);
  response = await invoke(handler, { method: 'POST', url: path, headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': 'test-session-token', 'content-type': 'application/json' }, body: '{"profile":"macos-pdfkit-top-level-outline-split-v1"}' });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(JSON.parse(response.body), { artifacts: [{ id: 'outline-split-1' }] });
  assert.equal(pdfkitOutlineSplits.calls.length, 1);
  const unavailable = await fixture(context, { pdfkitEnabled: false });
  response = await invoke(unavailable.handler, { method: 'POST', url: path, headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': 'test-session-token', 'content-type': 'application/json' }, body: '{"profile":"macos-pdfkit-top-level-outline-split-v1"}' });
  assert.equal(response.statusCode, 503);
});

test('authenticated project bundle routes export canonical state and import only into the identical source digest', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const pdf = makeTextPdf('PORTABLE AEC PROJECT');
  const first = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'drawing-a.pdf' });
  const second = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'drawing-b.pdf' });
  workspaceState.createEntity(first.id, 'measurements', { id: 'length-1', page: 1, value: 12.5 });
  const auth = { 'x-platen-token': 'test-session-token' };

  const exported = await invoke(handler, {
    url: `/api/documents/${first.id}/project-bundle`, headers: auth,
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers['Content-Type'].split(';', 1)[0], PROJECT_BUNDLE_MEDIA_TYPE);
  const bundleText = exported.body.toString('utf8');
  const bundle = JSON.parse(bundleText);
  assert.equal(bundle.sourcePdfSha256, first.sha256);
  assert.equal(bundleText.includes(first.id), false);

  const imported = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${second.id}/project-bundle?expectedRevision=0`,
    headers: {
      ...auth,
      origin: 'http://127.0.0.1:4173',
      'content-type': PROJECT_BUNDLE_MEDIA_TYPE,
    },
    body: bundleText,
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(JSON.parse(imported.body).workspace.documentId, second.id);
  assert.equal(JSON.parse(imported.body).workspace.namespaces.measurements[0].value, 12.5);

  const invalidQuery = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${second.id}/project-bundle?expectedRevision=1&extra=true`,
    headers: {
      ...auth,
      origin: 'http://127.0.0.1:4173',
      'content-type': PROJECT_BUNDLE_MEDIA_TYPE,
    },
    body: bundleText,
  });
  assert.equal(invalidQuery.statusCode, 400);
  assert.equal(JSON.parse(invalidQuery.body).error.code, 'INVALID_PARAMETER');

  const wrongMedia = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${second.id}/project-bundle?expectedRevision=1`,
    headers: {
      ...auth,
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
    },
    body: bundleText,
  });
  assert.equal(wrongMedia.statusCode, 415);
});

test('portable project routes stream the embedded PDF and restore a new digest-bound workspace', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const pdf = makeTextPdf('SELF CONTAINED PROJECT');
  const source = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'portable-drawing.pdf' });
  workspaceState.createEntity(source.id, 'measurements', { id: 'takeoff-1', quantity: 4, unit: 'count' });
  const auth = { 'x-platen-token': 'test-session-token' };
  const exported = await invoke(handler, {
    url: `/api/documents/${source.id}/portable-project-bundle`, headers: auth,
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers['Content-Type'], PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE);
  assert.equal(exported.body.length, Number(exported.headers['Content-Length']));

  const imported = await invoke(handler, {
    method: 'POST', url: '/api/project-bundles',
    headers: { ...auth, origin: 'http://127.0.0.1:4173', 'content-type': PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE },
    body: [exported.body.subarray(0, 13), exported.body.subarray(13)],
  });
  assert.equal(imported.statusCode, 201);
  const result = JSON.parse(imported.body).result;
  assert.notEqual(result.document.id, source.id);
  assert.equal(result.document.sha256, source.sha256);
  assert.equal(result.workspace.namespaces.measurements[0].quantity, 4);

  const rejected = await invoke(handler, {
    method: 'POST', url: '/api/project-bundles',
    headers: { ...auth, origin: 'http://127.0.0.1:4173', 'content-type': 'application/octet-stream' },
    body: exported.body,
  });
  assert.equal(rejected.statusCode, 415);
});

test('AEC artifact routes are authenticated, origin-bound, bounded, and call only fixed service operations', async (context) => {
  const { handler, store, aecArtifacts } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('AEC ROUTES')]), displayName: 'aec.pdf' });
  const headers = {
    origin: 'http://127.0.0.1:4173', 'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };
  for (const [route, body, expected] of [
    ['aec-calibration', { schemaVersion: 1, id: 'calibration-1' }, 'calibrate'],
    ['aec-measurement', { schemaVersion: 1, id: 'measurement-1' }, 'measure'],
    ['aec-materialization', { schemaVersion: 1, measurementId: 'measurement-1' }, 'materialize'],
  ]) {
    const response = await invoke(handler, {
      method: 'POST', url: `/api/documents/${document.id}/${route}`, headers, body: JSON.stringify(body),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(aecArtifacts.calls.at(-1).operation, expected);
    assert.deepEqual(aecArtifacts.calls.at(-1).body, body);
  }
  const foreign = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/aec-calibration`,
    headers: { ...headers, origin: 'https://foreign.example' }, body: '{}',
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(aecArtifacts.calls.length, 3);
});

test('authenticated prepress endpoint exposes only bounded named operations', async (context) => {
  const { handler, store } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('PREPRESS')]), displayName: 'prepress.pdf' });
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' };
  const result = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'separations', page: 1, dpi: 144 }) });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body).result.kind, 'separations');
  assert.equal(JSON.parse(result.body).result.options.page, 1);
  assert.equal(JSON.stringify(JSON.parse(result.body)).includes('/private/'), false);
  const preflight = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'preflight', profile: 'archive-review' }) });
  assert.equal(JSON.parse(preflight.body).result.kind, 'preflight-review');
  assert.equal(JSON.parse(preflight.body).result.options.profile, 'archive-review');
  const invalidProfile = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'preflight', profile: 'PDF/X-4' }) });
  assert.equal(invalidProfile.statusCode, 400);
  assert.equal(JSON.parse(invalidProfile.body).error.code, 'INVALID_PREFLIGHT_PROFILE');
  const wrongMethod = await invoke(handler, { method: 'GET', url: `/api/documents/${document.id}/prepress`, headers: { 'x-platen-token': 'test-session-token' } });
  assert.equal(wrongMethod.statusCode, 405);
  const arbitrary = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'renderSeparations' }) });
  assert.equal(arbitrary.statusCode, 400); assert.equal(JSON.parse(arbitrary.body).error.code, 'INVALID_PREPRESS_OPERATION');
  const invalidBody = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'ink-coverage', dpi: 144 }) });
  assert.equal(invalidBody.statusCode, 400); assert.equal(JSON.parse(invalidBody.body).error.code, 'INVALID_PREPRESS_OPTIONS');
  const cmyk = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'icc-convert', profile: 'ghostscript-default-cmyk' }) });
  assert.equal(JSON.parse(cmyk.body).result.kind, 'icc-cmyk-artifact');
  const invalidCmyk = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'icc-convert', profile: 'custom' }) });
  assert.equal(invalidCmyk.statusCode, 400); assert.equal(JSON.parse(invalidCmyk.body).error.code, 'INVALID_ICC_PROFILE');
  const imposed = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'imposition', layout: '2x2', marks: true }) });
  assert.deepEqual(JSON.parse(imposed.body).result.options.layout, '2x2');
  const invalidImposition = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'imposition', layout: '3x1', marks: 'yes' }) });
  assert.equal(invalidImposition.statusCode, 400); assert.equal(JSON.parse(invalidImposition.body).error.code, 'INVALID_IMPOSITION_OPTIONS');
  const production = await invoke(handler, { method: 'POST', url: `/api/documents/${document.id}/prepress`, headers, body: JSON.stringify({ operation: 'production-validation' }) });
  assert.equal(JSON.parse(production.body).result.kind, 'print-production-validation');
});

test('accessibility review route requires auth, same-origin POST, and the exact fixed profile body', async (context) => {
  const { handler, store } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('ACCESSIBILITY')]), displayName: 'accessibility.pdf' });
  const url = `/api/documents/${document.id}/accessibility-review`;
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' };
  const valid = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'basic-local-review' }) });
  assert.equal(valid.statusCode, 200);
  const body = JSON.parse(valid.body);
  assert.deepEqual(Object.keys(body), ['report']);
  assert.equal(body.report.sourceDigest, 'a'.repeat(64));
  assert.equal('document' in body.report, false);
  assert.equal(body.report.checks[0].status, 'not-checked');
  assert.doesNotMatch(JSON.stringify(body), /PDF\/UA validated|remediat/i);
  const extra = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'basic-local-review', extra: true }) });
  assert.equal(extra.statusCode, 400); assert.equal(JSON.parse(extra.body).error.code, 'INVALID_ACCESSIBILITY_REVIEW_OPTIONS');
  const wrongProfile = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'pdf-ua' }) });
  assert.equal(wrongProfile.statusCode, 400);
  const noAuth = await invoke(handler, { method: 'POST', url, headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'basic-local-review' }) });
  assert.equal(noAuth.statusCode, 401);
  const get = await invoke(handler, { method: 'GET', url, headers: { 'x-platen-token': 'test-session-token' } });
  assert.equal(get.statusCode, 405);
});

test('standards route accepts only fixed profiles, reports PDF/X unsupported before availability, and never exposes engine paths', async (context) => {
  const { handler, store, standardsValidations } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('STANDARDS')]), displayName: 'standards.pdf' });
  const url = `/api/documents/${document.id}/standards-validation`;
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' };
  const valid = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'pdfa-2u' }) });
  assert.equal(valid.statusCode, 200);
  const body = JSON.parse(valid.body);
  assert.equal(body.report.authoritative, true);
  assert.equal(body.report.complete, true);
  assert.equal(body.report.standard.profile, 'pdfa-2u');
  assert.equal(JSON.stringify(body).includes('/private/'), false);
  assert.equal(standardsValidations.calls[0].documentId, document.id);
  assert.equal(standardsValidations.calls[0].options.profile, 'pdfa-2u');
  assert.ok(standardsValidations.calls[0].options.signal instanceof AbortSignal);
  const extra = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'pdfa-2u', customProfile: '/tmp/evil.xml' }) });
  assert.equal(extra.statusCode, 400);
  assert.equal(JSON.parse(extra.body).error.code, 'INVALID_STANDARD_VALIDATION_OPTIONS');
  const custom = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'custom' }) });
  assert.equal(custom.statusCode, 400);
  assert.equal(JSON.parse(custom.body).error.code, 'INVALID_STANDARD_PROFILE');
  const query = await invoke(handler, { method: 'POST', url: `${url}?profile=/tmp/evil.xml`, headers, body: JSON.stringify({ profile: 'pdfa-2u' }) });
  assert.equal(query.statusCode, 400);
  const noAuth = await invoke(handler, { method: 'POST', url, headers: { origin: headers.origin, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'pdfa-2u' }) });
  assert.equal(noAuth.statusCode, 401);
  const wrongMethod = await invoke(handler, { method: 'GET', url, headers: { 'x-platen-token': 'test-session-token' } });
  assert.equal(wrongMethod.statusCode, 405);

  const unavailable = await fixture(context, { standardsEnabled: false });
  const unavailableDocument = await unavailable.store.createDocument({ stream: Readable.from([makeTextPdf('UNAVAILABLE')]), displayName: 'unavailable.pdf' });
  const unavailableUrl = `/api/documents/${unavailableDocument.id}/standards-validation`;
  const pdfx = await invoke(unavailable.handler, { method: 'POST', url: unavailableUrl, headers, body: JSON.stringify({ profile: 'pdfx' }) });
  assert.equal(pdfx.statusCode, 422);
  assert.equal(JSON.parse(pdfx.body).error.code, 'STANDARD_UNSUPPORTED');
  const missingEngine = await invoke(unavailable.handler, { method: 'POST', url: unavailableUrl, headers, body: JSON.stringify({ profile: 'pdfua-1' }) });
  assert.equal(missingEngine.statusCode, 503);
  assert.equal(JSON.parse(missingEngine.body).error.code, 'STANDARDS_VALIDATION_UNAVAILABLE');
});

test('accessibility proposal routes are authenticated, origin-bound for creation, and export only by server ID', async (context) => {
  const { handler, store, accessibilityRemediations } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('ACCESSIBILITY PROPOSAL')]), displayName: 'accessibility.pdf' });
  const url = `/api/documents/${document.id}/accessibility-proposal`;
  const auth = { 'x-platen-token': 'test-session-token' };
  const headers = { ...auth, origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' };
  const proposalRequest = { sourceSha256: document.sha256, reviewSha256: 'b'.repeat(64), expectedWorkspaceRevision: 0, operations: [{ action: 'author-tag-tree', target: null }] };
  const created = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify(proposalRequest) });
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body).proposal.proposalId, 'accessibility-proposal-1');
  assert.deepEqual(accessibilityRemediations.calls[0], { operation: 'create', documentId: document.id, body: proposalRequest });
  const exported = await invoke(handler, { url: `${url}?proposalId=accessibility-proposal-1`, headers: auth });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers['Content-Type'].split(';', 1)[0], ACCESSIBILITY_REMEDIATION_MEDIA_TYPE);
  assert.equal(JSON.parse(exported.body).conformanceClaim, false);
  assert.deepEqual(accessibilityRemediations.calls[1], { operation: 'export', documentId: document.id, proposalId: 'accessibility-proposal-1' });
  const foreign = await invoke(handler, { method: 'POST', url, headers: { ...headers, origin: 'http://attacker.example' }, body: JSON.stringify(proposalRequest) });
  assert.equal(foreign.statusCode, 403);
  const noAuth = await invoke(handler, { url: `${url}?proposalId=accessibility-proposal-1` });
  assert.equal(noAuth.statusCode, 401);
  const missingId = await invoke(handler, { url, headers: auth });
  assert.equal(missingId.statusCode, 400);
  const extraQuery = await invoke(handler, { url: `${url}?proposalId=accessibility-proposal-1&path=/tmp/evil`, headers: auth });
  assert.equal(extraQuery.statusCode, 400);
  const wrongMethod = await invoke(handler, { method: 'DELETE', url, headers });
  assert.equal(wrongMethod.statusCode, 405);
});

test('PDFKit route exposes only the staged fixed-profile read-only inventory', async (context) => {
  const { handler, store } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('PDFKIT')]), displayName: 'pdfkit.pdf' });
  const url = `/api/documents/${document.id}/pdfkit-inspection`;
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' };
  const valid = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'macos-read-only-v1' }) });
  assert.equal(valid.statusCode, 200);
  const body = JSON.parse(valid.body);
  assert.deepEqual(Object.keys(body), ['inspection']);
  assert.equal(body.inspection.kind, 'pdfkit-structure-inspection');
  assert.equal(body.inspection.evidence.operationMode, 'inventory-only');
  assert.equal('executable' in body.inspection, false);
  const extra = await invoke(handler, { method: 'POST', url, headers, body: JSON.stringify({ profile: 'macos-read-only-v1', path: '/tmp/evil' }) });
  assert.equal(extra.statusCode, 400);
  assert.equal(JSON.parse(extra.body).error.code, 'INVALID_PDFKIT_INSPECTION_OPTIONS');
  const query = await invoke(handler, { method: 'POST', url: `${url}?limit=999`, headers, body: JSON.stringify({ profile: 'macos-read-only-v1' }) });
  assert.equal(query.statusCode, 400);
  assert.equal(JSON.parse(query.body).error.code, 'INVALID_PARAMETER');
  const get = await invoke(handler, { method: 'GET', url, headers: { 'x-platen-token': 'test-session-token' } });
  assert.equal(get.statusCode, 405);
});

test('PDFKit route stays unavailable when no helper passed the staging boundary', async (context) => {
  const { handler, store } = await fixture(context, { pdfkitEnabled: false });
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('PDFKIT')]), displayName: 'pdfkit.pdf' });
  const response = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/pdfkit-inspection`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'test-session-token' },
    body: JSON.stringify({ profile: 'macos-read-only-v1' }),
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'PDFKIT_INSPECTION_UNAVAILABLE');
});
