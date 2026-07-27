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

test('authenticated creation, conversion-input, and rewrite routes preserve typed boundaries', async (context) => {
  const { handler } = await fixture(context);
  const jsonHeaders = {
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };
  const blank = await invoke(handler, {
    method: 'POST', url: '/api/documents/create-blank', headers: jsonHeaders,
    body: JSON.stringify({ pages: 3, title: 'Plans' }),
  });
  assert.deepEqual(JSON.parse(blank.body).document, { id: 'blank', options: { pages: 3, title: 'Plans' } });

  const text = await invoke(handler, {
    method: 'POST', url: '/api/documents/create-text', headers: jsonHeaders,
    body: JSON.stringify({ text: 'Local only', title: 'Notes' }),
  });
  assert.equal(JSON.parse(text.body).document.options.text, 'Local only');

  const input = await invoke(handler, {
    method: 'POST', url: '/api/inputs',
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'text/plain',
      'x-document-name': encodeURIComponent('../notes.txt'),
      'x-platen-token': 'test-session-token',
    },
    body: 'hello locally',
  });
  assert.equal(input.statusCode, 201);
  const inputRecord = JSON.parse(input.body).input;
  assert.equal(inputRecord.displayName, 'notes.txt');
  assert.equal(inputRecord.kind, 'text');
  assert.equal(Object.hasOwn(inputRecord, 'directory'), false);
  assert.equal(Object.hasOwn(inputRecord, 'sourcePath'), false);

  const fetchedInput = await invoke(handler, {
    url: `/api/inputs/${inputRecord.id}`,
    headers: { 'x-platen-token': 'test-session-token' },
  });
  assert.equal(fetchedInput.statusCode, 200);
  assert.deepEqual(JSON.parse(fetchedInput.body).input, inputRecord);

  const converted = await invoke(handler, {
    method: 'POST', url: `/api/inputs/${inputRecord.id}/convert`,
    headers: {
      origin: 'http://127.0.0.1:4173',
      'x-platen-token': 'test-session-token',
    },
  });
  assert.deepEqual(JSON.parse(converted.body).document, { id: 'converted', inputId: inputRecord.id });

  const uploaded = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/pdf',
      'x-platen-token': 'test-session-token',
    },
    body: makeTextPdf(),
  });
  const documentId = JSON.parse(uploaded.body).document.id;
  const rewritten = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/rewrite`, headers: jsonHeaders,
    body: JSON.stringify({ mode: 'optimize' }),
  });
  assert.deepEqual(JSON.parse(rewritten.body).document, { id: 'rewritten', documentId, mode: 'optimize' });

  const removed = await invoke(handler, {
    method: 'DELETE', url: `/api/inputs/${inputRecord.id}`,
    headers: {
      origin: 'http://127.0.0.1:4173',
      'x-platen-token': 'test-session-token',
    },
  });
  assert.equal(removed.statusCode, 204);
});

test('authenticated workspace routes persist revisioned local entities and reject stale writes', async (context) => {
  const { handler } = await fixture(context);
  const uploadHeaders = {
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/pdf',
    'x-platen-token': 'test-session-token',
  };
  const uploaded = await invoke(handler, {
    method: 'POST', url: '/api/documents', headers: uploadHeaders, body: makeTextPdf(),
  });
  const document = JSON.parse(uploaded.body).document;
  const jsonHeaders = {
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };

  const created = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${document.id}/workspace`,
    headers: jsonHeaders,
    body: JSON.stringify({
      action: 'create', namespace: 'annotations', expectedRevision: 0,
      entity: { id: 'note-1', page: 1, text: 'Review this' },
    }),
  });
  assert.equal(created.statusCode, 200);
  assert.equal(JSON.parse(created.body).workspace.revision, 1);

  const snapshot = await invoke(handler, {
    url: `/api/documents/${document.id}/workspace`,
    headers: { 'x-platen-token': 'test-session-token' },
  });
  assert.equal(JSON.parse(snapshot.body).workspace.namespaces.annotations[0].text, 'Review this');

  const stale = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${document.id}/workspace`,
    headers: jsonHeaders,
    body: JSON.stringify({
      action: 'update', namespace: 'annotations', entityId: 'note-1', expectedRevision: 0,
      entity: { id: 'note-1', page: 1, text: 'Lost update' },
    }),
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).error.code, 'REVISION_CONFLICT');
});

test('authenticated domain routes expose only allowlisted local prototype operations', async (context) => {
  const { handler } = await fixture(context);
  const upload = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/pdf',
      'x-platen-token': 'test-session-token',
    },
    body: makeTextPdf(),
  });
  const documentId = JSON.parse(upload.body).document.id;
  const operations = await invoke(handler, {
    url: '/api/domains', headers: { 'x-platen-token': 'test-session-token' },
  });
  assert.equal(JSON.parse(operations.body).operations.review.createAnnotation.supported, true);
  assert.equal(JSON.parse(operations.body).operations.redaction.apply.supported, false);

  const requestHeaders = {
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };
  const created = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/domain`, headers: requestHeaders,
    body: JSON.stringify({
      group: 'review', operation: 'createAnnotation',
      body: {
        input: { type: 'comment', page: 1, rectangle: [0, 0, 20, 20], text: 'Check this', author: 'Local reviewer' },
        options: { expectedRevision: 0 },
      },
    }),
  });
  assert.equal(created.statusCode, 200);
  assert.equal(JSON.parse(created.body).result.namespaces.annotations[0].prototypeSidecar, true);

  const rejected = await invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/domain`, headers: requestHeaders,
    body: JSON.stringify({ group: 'redaction', operation: 'apply', body: {} }),
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(JSON.parse(rejected.body).error.code, 'DOMAIN_OPERATION_UNSUPPORTED');
});
