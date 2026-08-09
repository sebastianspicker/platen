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

test('local host client deletes one exact ephemeral artifact through an authenticated request', async () => {
  const calls = [];
  const artifactId = '33333333-3333-4333-8333-333333333333';
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  } });
  await client.bootstrap();
  await client.deleteArtifact(artifactId, { keepalive: true });
  assert.equal(calls[1].path, `/api/artifacts/${artifactId}`);
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].options.keepalive, true);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  await assert.rejects(client.deleteArtifact('unsafe'), TypeError);
  await assert.rejects(client.deleteArtifact(artifactId, { keepalive: 'yes' }), TypeError);
});

test('local host client preserves legacy OCR language and maps typed layout analysis', async () => {
  const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 }); if (path.endsWith('/ocr-analysis')) return new Response(JSON.stringify({ result: ocrLayoutResult() }), { status: 200 }); return new Response(JSON.stringify(ocrDocumentResult('doc', 'deu')), { status: 201 }); } });
  await client.bootstrap(); assert.equal((await client.ocrDocument('doc', 'deu')).result.language, 'deu'); assert.deepEqual(JSON.parse(calls[1].options.body), { language: 'deu', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [] });
  assert.equal((await client.analyzeOcrLayout('doc', { pages: [1], zones: [], detectTables: false })).kind, 'ocr-layout-evidence'); assert.equal(calls[2].path, '/api/documents/doc/ocr-analysis');
  await assert.doesNotReject(client.analyzeOcrLayout('doc', { pages: [1], zones: [{ id: 'zone-1', type: 'text', page: 1, x: 0, y: 0, width: 1, height: 1 }] }));
  await assert.rejects(client.ocrDocument('other-document', 'deu'), /different document/u);
  assert.throws(() => client.analyzeOcrLayout('doc', { pages: [0] }), TypeError); assert.throws(() => client.ocrDocument('doc', { cleanupPreset: 'bad' }), TypeError);
});

test('local host client posts a contract-normalized OCR batch and rejects malformed manifests', async () => {
  const calls = [];
  const manifest = {
    kind: 'ocr-batch-manifest', schemaVersion: 1, status: 'succeeded',
    requests: [{ id: 1, documentId: 'doc', kind: 'document', status: 'completed', output: ocrDocumentResult() }],
    evidence: { localOnly: true, sourceBound: true, engines: ['Poppler', 'ImageMagick', 'Tesseract'], ordered: true, sequential: true, aggregatePages: 1, aggregateInputBytes: 1, aggregateOutputBytes: 1 }, limitations: ['Review OCR output.'],
  };
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ manifest }), { status: 200 });
  } });
  await client.bootstrap();
  const result = await client.ocrBatch({ requests: [{ id: 1, documentId: 'doc', kind: 'document', options: { language: 'eng', userDictionary: ['  caf\u00e9  '] } }] }, ['eng']);
  assert.equal(result.results[0].artifact.id, 'artifact');
  assert.equal(calls[1].path, '/api/ocr/batch');
  assert.deepEqual(JSON.parse(calls[1].options.body), { requests: [{ id: 1, documentId: 'doc', kind: 'document', options: { language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: ['caf\u00e9'] } }] });
  assert.throws(() => client.ocrBatch({ requests: [] }, ['eng']), TypeError);
});

test('local host client requests bounded structural evidence', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ structure: { pageCount: 3 } }), { status: 200 });
  } });
  await client.bootstrap();
  assert.deepEqual(await client.inspectStructure('doc', {
    firstPage: 2, lastPage: 3, includeTagText: true,
  }), { pageCount: 3 });
  assert.equal(calls[1].path, '/api/documents/doc/structure?first=2&includeTagText=true&last=3');
  assert.throws(() => client.inspectStructure('doc', { firstPage: 0 }), TypeError);
  assert.throws(() => client.inspectStructure('doc', { firstPage: 3, lastPage: 2 }), TypeError);
});

test('local host client exposes typed page composition requests', async () => {
  const primary = '11111111-1111-4111-8111-111111111111';
  const secondary = '22222222-2222-4222-8222-222222222222';
  const primarySha256 = 'a'.repeat(64);
  const secondarySha256 = 'b'.repeat(64);
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token, engines: [] }), { status: 200 });
    }
    if (path.endsWith('/split') || path.endsWith('/split-rule')) return new Response(JSON.stringify({ artifacts: [{}] }), { status: 201 });
    return new Response(JSON.stringify({ artifact: {} }), { status: 201 });
  };
  const client = new LocalHostClient({ fetchImpl });
  await client.bootstrap();

  const invalidReceipt = { code: 'INVALID_LOCAL_HOST' };
  await assert.rejects(client.splitDocument(primary, primarySha256), invalidReceipt);
  await assert.rejects(client.splitByPageCount(primary, primarySha256, 2), invalidReceipt);
  await assert.rejects(client.duplicatePages(primary, primarySha256, [2]), invalidReceipt);
  await assert.rejects(client.reversePages(primary, primarySha256), invalidReceipt);
  await assert.rejects(client.interleaveDocuments(primary, primarySha256, secondary, secondarySha256), invalidReceipt);
  await assert.rejects(client.insertDocument(primary, primarySha256, secondary, secondarySha256, 2), invalidReceipt);
  await assert.rejects(client.replacePages(primary, primarySha256, secondary, secondarySha256, 2, 3), invalidReceipt);

  assert.deepEqual(calls.slice(1).map(({ path }) => path), [
    `/api/documents/${primary}/split`,
    `/api/documents/${primary}/split-rule`,
    `/api/documents/${primary}/duplicate`,
    `/api/documents/${primary}/reverse`,
    `/api/documents/${primary}/interleave`,
    `/api/documents/${primary}/insert`,
    `/api/documents/${primary}/replace`,
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { sourceSha256: primarySha256 });
  assert.deepEqual(JSON.parse(calls[2].options.body), { sourceSha256: primarySha256, pagesPerOutput: 2 });
  assert.deepEqual(JSON.parse(calls[3].options.body), { sourceSha256: primarySha256, pages: [2] });
  assert.deepEqual(JSON.parse(calls[5].options.body), { primarySourceSha256: primarySha256, secondaryDocumentId: secondary, secondarySourceSha256: secondarySha256 });
  assert.deepEqual(JSON.parse(calls[6].options.body), { primarySourceSha256: primarySha256, secondaryDocumentId: secondary, secondarySourceSha256: secondarySha256, afterPage: 2 });
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    primarySourceSha256: primarySha256, secondaryDocumentId: secondary, secondarySourceSha256: secondarySha256, startPage: 2, endPage: 3,
  });
  assert.equal(calls.slice(1).every(({ options }) => options.headers['X-Platen-Token'] === token), true);
});

test('local host client reads and mutates revisioned workspace state', async () => {
  const calls = [];
  const workspace = { documentId: 'doc', revision: 1, namespaces: {}, audit: [] };
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ workspace }), { status: 200 });
  } });
  await client.bootstrap();
  assert.equal((await client.workspace('doc')).revision, 1);
  await client.mutateWorkspace('doc', {
    action: 'create', namespace: 'annotations', entity: { id: 'note-1' }, expectedRevision: 0,
  });
  await client.replaceWorkspace('doc', workspace, 1);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(JSON.parse(calls[2].options.body).entity.id, 'note-1');
  assert.equal(calls[3].options.method, 'PUT');
  assert.equal(JSON.parse(calls[3].options.body).expectedRevision, 1);
});

test('local host client exposes creation, conversion, rewrite, and derived-source requests', async () => {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (path === '/api/inputs' && options.method === 'POST') {
      return new Response(JSON.stringify({ input: { id: 'input' } }), { status: 201 });
    }
    if (path === '/api/inputs/input/convert') {
      return new Response(JSON.stringify({ document: { id: 'converted' } }), { status: 201 });
    }
    if (path === '/api/documents/create-blank') {
      return new Response(JSON.stringify({ document: { id: 'blank' } }), { status: 201 });
    }
    if (path === '/api/documents/create-text') {
      return new Response(JSON.stringify({ document: { id: 'text' } }), { status: 201 });
    }
    if (path === '/api/documents/doc/rewrite') {
      return new Response(JSON.stringify({ document: { id: 'rewritten' } }), { status: 201 });
    }
    if (path === '/api/documents/converted/source') {
      return new Response('%PDF-1.7\n%%EOF', { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    if (path === '/api/inputs/input' && options.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`unexpected path ${path}`);
  };
  const client = new LocalHostClient({ fetchImpl });
  await client.bootstrap();
  const file = new Blob(['local text'], { type: 'text/plain' });
  Object.defineProperty(file, 'name', { value: 'notes.txt' });

  assert.deepEqual(await client.uploadInput(file), { id: 'input' });
  assert.deepEqual(await client.convertInput('input'), { id: 'converted' });
  assert.deepEqual(await client.createBlank({ pages: 2 }), { id: 'blank' });
  assert.deepEqual(await client.createText({ text: 'hello' }), { id: 'text' });
  assert.deepEqual(await client.rewriteDocument('doc', 'optimize'), { id: 'rewritten' });
  assert.equal((await client.documentSource('converted')).type, 'application/pdf');
  await client.deleteInput('input');

  assert.equal(calls[1].options.headers['Content-Type'], 'text/plain');
  assert.equal(JSON.parse(calls[3].options.body).pages, 2);
  assert.equal(JSON.parse(calls[5].options.body).mode, 'optimize');
  assert.equal(calls.slice(1).every(({ options }) => options.headers['X-Platen-Token'] === token), true);
});

test('local host client lists and executes allowlisted domain operations', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    if (path === '/api/domains') {
      return new Response(JSON.stringify({ operations: { review: { createAnnotation: { supported: true } } } }), { status: 200 });
    }
    if (path === '/api/documents/doc/domain') {
      return new Response(JSON.stringify({ result: { revision: 1 } }), { status: 200 });
    }
    throw new Error(`unexpected path ${path}`);
  } });
  await client.bootstrap();
  assert.equal((await client.domainOperations()).review.createAnnotation.supported, true);
  assert.deepEqual(await client.executeDomain('doc', 'review', 'createAnnotation', { input: { text: 'Local' } }), { revision: 1 });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    group: 'review', operation: 'createAnnotation', body: { input: { text: 'Local' } },
  });
  assert.equal(calls[2].options.headers['X-Platen-Token'], token);
});
