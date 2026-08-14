import test from 'node:test';
import {
  assert,
  fixture,
  invoke,
  makeTextPdf,
} from './support/host-router-fixture.js';
import {
  authenticatedHeaders,
  createUploadedRouterFixture,
  jsonHeaders,
  tokenHeader,
} from './support/host-router-document-api-fixture.js';

test('API rejects missing authentication, foreign origins, methods, and media types', async (context) => {
  const { handler } = await fixture(context);
  const pdf = makeTextPdf();
  const unauthorized = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/pdf' }, body: pdf,
  });
  assert.equal(unauthorized.statusCode, 401);

  const foreign = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: {
      origin: 'https://attacker.example', 'content-type': 'application/pdf', ...tokenHeader,
    },
    body: pdf,
  });
  assert.equal(foreign.statusCode, 403);

  const wrongType = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: { ...authenticatedHeaders, 'content-type': 'text/plain' }, body: pdf,
  });
  assert.equal(wrongType.statusCode, 415);
  const wrongMethod = await invoke(handler, { method: 'POST', url: '/api/bootstrap' });
  assert.equal(wrongMethod.statusCode, 405);
});

test('authenticated upload and read-only routes return bounded typed evidence', async (context) => {
  const { document, handler, pdf, store } = await createUploadedRouterFixture(context);
  assert.equal(document.displayName, 'report.pdf');
  assert.deepEqual(store.getDocument(document.id).sha256, document.sha256);

  const inspection = await invoke(handler, {
    url: `/api/documents/${document.id}/inspection`, headers: tokenHeader,
  });
  assert.equal(inspection.statusCode, 200);
  assert.equal(JSON.parse(inspection.body).inspection.pageCount, 1);

  const structure = await invoke(handler, {
    url: `/api/documents/${document.id}/structure?first=1&last=1&includeTagText=true`,
    headers: tokenHeader,
  });
  const structureBody = JSON.parse(structure.body).structure;
  assert.equal(structure.statusCode, 200);
  assert.equal(structureBody.options.firstPage, 1);
  assert.equal(structureBody.options.lastPage, 1);
  assert.equal(structureBody.options.includeTagText, true);

  const signatures = await invoke(handler, {
    url: `/api/documents/${document.id}/signatures`, headers: tokenHeader,
  });
  const signatureEvidence = JSON.parse(signatures.body).signatures;
  assert.equal(signatures.statusCode, 200);
  assert.equal(signatureEvidence.status, 'unsigned');
  assert.equal(signatureEvidence.signatureCount, 0);
  assert.equal('raw' in signatureEvidence, false);
  assert.doesNotMatch(signatures.body.toString('utf8'), /\/private\/|source\.pdf/);

  const source = await invoke(handler, {
    url: `/api/documents/${document.id}/source`, headers: tokenHeader,
  });
  assert.equal(source.statusCode, 200);
  assert.deepEqual(source.body, pdf);
  assert.match(source.headers['Content-Disposition'], /report\.pdf/);
});

test('authenticated raster routes enforce fixed DPI and crop bounds', async (context) => {
  const { document, handler } = await createUploadedRouterFixture(context);
  for (const [endpoint, expectedBody] of [
    ['thumbnail?page=1&dpi=192', Buffer.from([137, 80, 78, 71])],
    ['cropbox-raster?page=1&dpi=192', null],
    ['cropbox-snapshot?page=1&dpi=192&x=0.1&y=0.2&width=0.3&height=0.4', null],
  ]) {
    const response = await invoke(handler, {
      url: `/api/documents/${document.id}/${endpoint}`, headers: tokenHeader,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'].split(';', 1)[0], 'image/png');
    if (expectedBody) assert.deepEqual(response.body, expectedBody);
  }

  for (const endpoint of [
    'thumbnail?page=1&dpi=35', 'thumbnail?page=1&dpi=241',
    'cropbox-raster?page=1&dpi=241',
    'cropbox-raster?page=1&dpi=192&flag=unsafe',
  ]) {
    const response = await invoke(handler, {
      url: `/api/documents/${document.id}/${endpoint}`, headers: tokenHeader,
    });
    assert.equal(response.statusCode, 400);
  }

  for (const query of [
    'page=1&dpi=192&x=0.8&y=0&width=0.3&height=1',
    'page=1&dpi=192&x=0&y=0&width=1&height=1&extra=true',
    'page=1&dpi=192&x=0.1234567&y=0&width=0.5&height=1',
    'page=1&dpi=192&x=0&y=0&width=0&height=1',
  ]) {
    const response = await invoke(handler, {
      url: `/api/documents/${document.id}/cropbox-snapshot?${query}`, headers: tokenHeader,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_PARAMETER');
  }

  const unauthorized = await invoke(handler, {
    url: `/api/documents/${document.id}/thumbnail?page=1&dpi=192`,
  });
  assert.equal(unauthorized.statusCode, 401);
  const wrongMethod = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/thumbnail?page=1&dpi=192`,
    headers: { origin: authenticatedHeaders.origin, ...tokenHeader },
  });
  assert.equal(wrongMethod.statusCode, 405);
});

test('document arrangement routes return their exact derived-artifact contracts', async (context) => {
  const { document, handler } = await createUploadedRouterFixture(context);
  const arranged = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/arrange`, headers: jsonHeaders,
    body: JSON.stringify({ sourceSha256: document.sha256, pages: [1] }),
  });
  assert.equal(arranged.statusCode, 201);
  assert.deepEqual(JSON.parse(arranged.body).artifact.pages, [1]);

  const split = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/split`, headers: jsonHeaders,
    body: JSON.stringify({ sourceSha256: document.sha256 }),
  });
  assert.equal(split.statusCode, 201);
  assert.deepEqual(JSON.parse(split.body).artifacts, [{ id: 'split-1' }]);

  const splitRule = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/split-rule`, headers: jsonHeaders,
    body: JSON.stringify({ sourceSha256: document.sha256, pagesPerOutput: 2 }),
  });
  assert.equal(splitRule.statusCode, 201);
  assert.deepEqual(JSON.parse(splitRule.body).artifacts, [{
    id: 'split-rule-1', pagesPerOutput: 2,
  }]);

  const reverse = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/reverse`, headers: jsonHeaders,
    body: JSON.stringify({ sourceSha256: document.sha256 }),
  });
  assert.equal(JSON.parse(reverse.body).artifact.id, 'reversed');

  const deleteAll = await invoke(handler, {
    method: 'POST', url: `/api/documents/${document.id}/delete`, headers: jsonHeaders,
    body: JSON.stringify({ sourceSha256: document.sha256, pages: [1] }),
  });
  assert.equal(deleteAll.statusCode, 400);
  assert.equal(JSON.parse(deleteAll.body).error.code, 'INVALID_PAGES');
});

test('document composition routes preserve each bounded request shape', async (context) => {
  const { document, handler } = await createUploadedRouterFixture(context);
  const secondaryResponse = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: { ...authenticatedHeaders, 'content-type': 'application/pdf' },
    body: makeTextPdf(),
  });
  const secondary = JSON.parse(secondaryResponse.body).document;
  const secondaryRequest = {
    primarySourceSha256: document.sha256,
    secondaryDocumentId: secondary.id,
    secondarySourceSha256: secondary.sha256,
  };
  const cases = [
    ['duplicate', { sourceSha256: document.sha256, pages: [1] }, { id: 'duplicated', pages: [1] }],
    ['merge', secondaryRequest, {
      id: 'merged', secondaryDocumentId: secondary.id,
    }],
    ['interleave', secondaryRequest, {
      id: 'interleaved', secondaryDocumentId: secondary.id,
    }],
    ['insert', { ...secondaryRequest, afterPage: 0 }, {
      id: 'inserted', secondaryDocumentId: secondary.id, afterPage: 0,
    }],
    ['replace', { ...secondaryRequest, startPage: 1, endPage: 1 }, {
      id: 'replaced', secondaryDocumentId: secondary.id, startPage: 1, endPage: 1,
    }],
    ['copy-page', {
      profile: 'local-copy-one-page-between-documents-v1',
      primarySourceSha256: document.sha256,
      secondaryDocumentId: '22222222-2222-4222-8222-222222222222',
      secondarySourceSha256: 'b'.repeat(64),
      sourcePage: 2,
      afterPage: 1,
    }, {
      id: 'copied-page',
      secondaryDocumentId: '22222222-2222-4222-8222-222222222222',
      request: {
        profile: 'local-copy-one-page-between-documents-v1',
        primarySourceSha256: document.sha256,
        secondarySourceSha256: 'b'.repeat(64),
        sourcePage: 2,
        afterPage: 1,
      },
    }],
  ];
  for (const [operation, requestBody, expected] of cases) {
    const response = await invoke(handler, {
      method: 'POST', url: `/api/documents/${document.id}/${operation}`,
      headers: jsonHeaders, body: JSON.stringify(requestBody),
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(JSON.parse(response.body).artifact, expected);
  }
});

test('document routes reject encoded traversal identifiers', async (context) => {
  const { handler } = await fixture(context);
  const response = await invoke(handler, {
    url: '/api/documents/..%2F..%2Fetc%2Fpasswd', headers: tokenHeader,
  });
  assert.equal(response.statusCode, 400);
});
