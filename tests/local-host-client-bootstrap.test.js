import test from 'node:test';
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

test('local host client bootstraps and sends authenticated same-origin API requests', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token, host: { localOnly: true }, engines: [] }), { status: 200 });
    if (path === '/api/documents') return new Response(JSON.stringify({ document: { id: 'doc' } }), { status: 201 });
    throw new Error(`unexpected path ${path}`);
  };
  const client = new LocalHostClient({ fetchImpl });
  await client.bootstrap();
  const file = new Blob(['%PDF-1.7\n%%EOF'], { type: 'application/pdf' });
  Object.defineProperty(file, 'name', { value: 'report.pdf' });
  assert.deepEqual(await client.upload(file), { id: 'doc' });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[1].options.headers['Content-Type'], 'application/pdf');
  assert.equal(calls[1].options.credentials, 'omit');
});

test('local host client preserves the browser receiver for the default fetch transport', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = function receiverSensitiveFetch(path, options) {
    assert.equal(this, globalThis);
    calls.push({ path, options });
    return Promise.resolve(new Response(JSON.stringify({ sessionToken: token, engines: [] }), { status: 200 }));
  };

  try {
    const client = new LocalHostClient();
    await client.bootstrap();
    assert.equal(calls[0].path, '/api/bootstrap');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local host client rejects invalid bootstrap identity and typed API errors', async () => {
  const invalid = new LocalHostClient({ fetchImpl: async () => new Response(JSON.stringify({ sessionToken: 'short' }), { status: 200 }) });
  await assert.rejects(invalid.bootstrap(), { code: 'INVALID_LOCAL_HOST' });

  let count = 0;
  const failing = new LocalHostClient({ fetchImpl: async () => {
    count += 1;
    if (count === 1) return new Response(JSON.stringify({ sessionToken: token, engines: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'ENGINE_UNAVAILABLE', message: 'Poppler missing.' } }), { status: 503 });
  } });
  await failing.bootstrap();
  await assert.rejects(failing.inspect('doc'), { code: 'ENGINE_UNAVAILABLE', message: 'Poppler missing.' });
});

test('local host client requests an authenticated bounded page raster as a Blob', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } });
  } });
  await client.bootstrap();
  const controller = new AbortController();
  const raster = await client.thumbnail('doc', 2, 192, { signal: controller.signal });
  assert(raster instanceof Blob);
  assert.equal(raster.type, 'image/png');
  assert.equal(calls[1].path, '/api/documents/doc/thumbnail?page=2&dpi=192');
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[1].options.signal, controller.signal);
});

test('local host client requests the dedicated authenticated CropBox raster profile', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } });
  } });
  await client.bootstrap();
  const controller = new AbortController();
  await client.cropBoxRaster('doc', 2, 192, { signal: controller.signal });
  assert.equal(calls[1].path, '/api/documents/doc/cropbox-raster?page=2&dpi=192');
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(() => client.cropBoxRaster('../escape', 1), /documentId/);
  assert.throws(() => client.cropBoxRaster('doc', 0), /page/);
  assert.throws(() => client.cropBoxRaster('doc', 1, 241), /dpi/);
});

test('local host client requests one bounded normalized CropBox snapshot region', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } });
  } });
  await client.bootstrap();
  const controller = new AbortController();
  const blob = await client.cropBoxSnapshot('doc', 2, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 192, {
    signal: controller.signal,
  });
  assert.equal(blob.type, 'image/png');
  assert.equal(calls[1].path, '/api/documents/doc/cropbox-snapshot?page=2&dpi=192&x=0.1&y=0.2&width=0.3&height=0.4');
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(() => client.cropBoxSnapshot('../escape', 1, { x: 0, y: 0, width: 1, height: 1 }), /documentId/);
  assert.throws(() => client.cropBoxSnapshot('doc', 0, { x: 0, y: 0, width: 1, height: 1 }), /page/);
  assert.throws(() => client.cropBoxSnapshot('doc', 1, { x: 0.8, y: 0, width: 0.3, height: 1 }), /inside/);
  assert.throws(() => client.cropBoxSnapshot('doc', 1, { x: 0, y: 0, width: 1, height: 1 }, 241), /dpi/);
});

test('local host client exposes only typed bounded prepress requests', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: { kind: 'separation-preview' } }), { status: 200 });
  } });
  await client.bootstrap();
  assert.deepEqual(await client.runPrepress('doc', 'separations', { page: 1, dpi: 144 }), { kind: 'separation-preview' });
  assert.equal(calls[1].path, '/api/documents/doc/prepress');
  assert.deepEqual(JSON.parse(calls[1].options.body), { operation: 'separations', page: 1, dpi: 144 });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.throws(() => client.runPrepress('doc', 'ghostscript', {}), TypeError);
  assert.throws(() => client.runPrepress('doc', 'ink-coverage', { dpi: 144 }), TypeError);
  assert.throws(() => client.runPrepress('doc', 'overprint-preview', { page: 0 }), TypeError);
  assert.deepEqual(await client.runPrepress('doc', 'preflight', { profile: 'archive-review' }), { kind: 'separation-preview' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { operation: 'preflight', profile: 'archive-review' });
  assert.throws(() => client.runPrepress('doc', 'preflight', { profile: 'custom' }), TypeError);
  assert.throws(() => client.runPrepress('doc', 'preflight', { dpi: 144 }), TypeError);
  assert.deepEqual(await client.convertToCmyk('doc'), { kind: 'separation-preview' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { operation: 'icc-convert', profile: 'ghostscript-default-cmyk' });
  assert.throws(() => client.convertToCmyk('doc', { profile: 'custom' }), TypeError);
  assert.throws(() => client.convertToCmyk('doc', { profile: 'ghostscript-default-cmyk', layout: '2x1' }), TypeError);
  assert.deepEqual(await client.createImposition('doc', { layout: '2x2', marks: true }), { kind: 'separation-preview' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { operation: 'imposition', layout: '2x2', marks: true });
  assert.throws(() => client.createImposition('doc', { layout: '3x1', marks: true }), TypeError);
  assert.deepEqual(await client.runProductionValidation('doc'), { kind: 'separation-preview' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { operation: 'production-validation' });
  assert.throws(() => client.runProductionValidation('doc', { profile: 'anything' }), TypeError);
  const outputIntentRequest = {
    profile: 'local-ghostscript-default-cmyk-output-intent-v1',
    sourceSha256: 'a'.repeat(64),
  };
  const controller = new AbortController();
  assert.deepEqual(
    await client.assignOutputIntent('doc', outputIntentRequest, { signal: controller.signal }),
    { kind: 'separation-preview' },
  );
  assert.equal(calls.at(-1).path, '/api/documents/doc/prepress/output-intent');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), outputIntentRequest);
  assert.equal(calls.at(-1).options.signal, controller.signal);
  assert.throws(() => client.assignOutputIntent('doc', {
    ...outputIntentRequest, profile: 'custom',
  }), TypeError);
  assert.throws(() => client.assignOutputIntent('doc', {
    ...outputIntentRequest, unsafe: true,
  }), TypeError);
  assert.throws(() => client.assignOutputIntent('doc', outputIntentRequest, {
    signal: controller.signal, unsafe: true,
  }), TypeError);
});

test('local host client posts exact source-bound layer-defaults changes', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: { kind: 'pdf-layer-defaults', limitations: ['bounded'] } }), { status: 201 });
  } });
  await client.bootstrap();
  const digest = 'a'.repeat(64);
  const changes = [{ groupIndex: 0, visible: false }, { groupIndex: 2, visible: true }];
  const documentId = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(await client.runLayerDefaults(documentId, digest, changes), { kind: 'pdf-layer-defaults', limitations: ['bounded'] });
  assert.equal(calls[1].path, `/api/documents/${documentId}/layer-defaults`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: 'local-layer-defaults-v1', sourceSha256: digest, changes });
  assert.throws(() => client.runLayerDefaults('doc', digest, [{ groupIndex: 2, visible: true }, { groupIndex: 1, visible: false }]), TypeError);
  assert.throws(() => client.runLayerDefaults('doc', digest.toUpperCase(), changes), TypeError);
});

test('local host client lists privacy-minimal identities and posts fixed certificate-sign requests', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 }); if (path === '/api/signing-identities') return new Response(JSON.stringify({ identities: [{ certificateSha256: 'a'.repeat(64), certificateBytes: 4 }] }), { status: 200 }); return new Response(JSON.stringify({ result: { kind: 'pdf-certificate-signature' } }), { status: 201 }); } });
  await client.bootstrap();
  assert.deepEqual(await client.listSigningIdentities(), { identities: [{ certificateSha256: 'a'.repeat(64), certificateBytes: 4 }] });
  const documentId = '123e4567-e89b-12d3-a456-426614174000'; const sourceSha256 = 'b'.repeat(64); const certificateSha256 = 'a'.repeat(64);
  assert.deepEqual(await client.signCertificate(documentId, { profile: 'local-pdf-signature-container-v1', sourceSha256, certificateSha256, page: 1, fieldName: 'Signature', reason: '', location: '', contact: '', placeholderBytes: 4096 }), { kind: 'pdf-certificate-signature' });
  assert.equal(calls[2].path, `/api/documents/${documentId}/certificate-sign`); assert.equal(JSON.parse(calls[2].options.body).certificateSha256, certificateSha256);
});

test('local host client posts fixed hidden-data sanitization source binding', async () => {
  const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 }); return new Response(JSON.stringify({ result: { kind: 'pdf-hidden-data-sanitization', limitations: ['no secure erasure'] } }), { status: 201 }); } });
  await client.bootstrap(); const id = '123e4567-e89b-12d3-a456-426614174000'; const digest = 'a'.repeat(64); assert.deepEqual(await client.sanitizeHiddenData(id, digest), { kind: 'pdf-hidden-data-sanitization', limitations: ['no secure erasure'] }); assert.equal(calls[1].path, `/api/documents/${id}/sanitize-hidden-data`); assert.deepEqual(JSON.parse(calls[1].options.body), { profile: 'local-pdf-hidden-data-sanitizer-v1', sourceSha256: digest });
});

test('local host client exposes one fixed document-bound accessibility review', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ report: { kind: 'accessibility-review', status: 'review-required' } }), { status: 200 });
  } });
  await client.bootstrap();
  assert.deepEqual(await client.runAccessibilityReview('doc'), { kind: 'accessibility-review', status: 'review-required' });
  assert.equal(calls[1].path, '/api/documents/doc/accessibility-review');
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: 'basic-local-review' });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.throws(() => client.runAccessibilityReview('doc', { profile: 'pdf-ua' }), TypeError);
  assert.throws(() => client.runAccessibilityReview('doc', { profile: 'basic-local-review', rules: [] }), TypeError);
});

test('local host client exposes only fixed PDF/A, PDF/UA, and explicit unsupported PDF/X validation requests', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ report: { kind: 'standards-validation', status: 'compliant' } }), { status: 200 });
  } });
  await client.bootstrap();
  assert.deepEqual(await client.runStandardsValidation('doc', 'pdfa-2u'), { kind: 'standards-validation', status: 'compliant' });
  assert.equal(calls[1].path, '/api/documents/doc/standards-validation');
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: 'pdfa-2u' });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  await client.runStandardsValidation('doc', 'pdfua-2');
  await client.runStandardsValidation('doc', 'pdfx');
  assert.throws(() => client.runStandardsValidation('doc', 'PDF/A-2u'), TypeError);
  assert.throws(() => client.runStandardsValidation('doc', 'pdfa-2u', { customProfile: '/tmp/profile.xml' }), TypeError);
});

test('local host client creates and exports only bounded source-bound accessibility proposals', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (options.method === 'POST') return new Response(JSON.stringify({ proposal: { proposalId: 'proposal-1', revision: 1 } }), { status: 201 });
    return new Response('{"id":"proposal-1"}', { status: 200, headers: { 'Content-Type': 'application/vnd.platen.accessibility-proposal+json' } });
  } });
  await client.bootstrap();
  const request = {
    sourceSha256: 'a'.repeat(64), reviewSha256: 'b'.repeat(64), expectedWorkspaceRevision: 0,
    operations: [{ action: 'author-image-alt-text', target: { locator: 'c'.repeat(64) }, authoredText: '  cafe\u0301 photo  ' }],
  };
  assert.deepEqual(await client.createAccessibilityProposal('doc', request, { signal: controller.signal }), { proposalId: 'proposal-1', revision: 1 });
  assert.equal(calls[1].path, '/api/documents/doc/accessibility-proposal');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ...request, operations: [{ ...request.operations[0], authoredText: 'caf\u00e9 photo' }] });
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(await client.exportAccessibilityProposal('doc', 'proposal-1'), '{"id":"proposal-1"}');
  assert.equal(calls[2].path, '/api/documents/doc/accessibility-proposal?proposalId=proposal-1');
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [] }), TypeError);
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, sourceSha256: 'A'.repeat(64) }), TypeError);
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ action: 'fix', target: { locator: 'c'.repeat(64), path: '/tmp/evil' } }] }), TypeError);
  for (const authoredText of ['', ' '.repeat(1001), 'bad\u0000text', 'bad\u202Etext', '\uD800']) {
    assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ ...request.operations[0], authoredText }] }), TypeError);
  }
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ action: 'author-image-alt-text', target: { locator: 'c'.repeat(64) } }] }), TypeError);
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ action: 'author-tag-tree', target: null, authoredText: 'wrong action' }] }), TypeError);
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ action: 'author-image-alt-text', target: null, authoredText: 'missing target' }] }), TypeError);
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ action: 'author-image-alt-text', target: {}, authoredText: 'missing locator' }] }), TypeError);
  assert.throws(() => client.createAccessibilityProposal('doc', { ...request, operations: [{ ...request.operations[0], extra: true }] }), TypeError);
  assert.throws(() => client.exportAccessibilityProposal('doc', '../proposal'), TypeError);
});

test('local host client exposes one fixed pinned PDFKit inventory request', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ inspection: { kind: 'pdfkit-structure-inspection', pageCount: 1 } }), { status: 200 });
  } });
  await client.bootstrap();
  assert.deepEqual(await client.runPdfKitInspection('doc'), { kind: 'pdfkit-structure-inspection', pageCount: 1 });
  assert.equal(calls[1].path, '/api/documents/doc/pdfkit-inspection');
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: 'macos-read-only-v1' });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.throws(() => client.runPdfKitInspection('doc', { path: '/tmp/evil' }), TypeError);
});

test('local host client posts the one fixed verified top-level-outline split request', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ artifacts: [{ id: 'outline-1' }] }), { status: 201 });
  } });
  await client.bootstrap();
  assert.deepEqual(await client.splitByVerifiedTopLevelOutline('doc'), [{ id: 'outline-1' }]);
  assert.equal(calls[1].path, '/api/documents/doc/split-outline');
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: 'macos-pdfkit-top-level-outline-split-v1' });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
});
