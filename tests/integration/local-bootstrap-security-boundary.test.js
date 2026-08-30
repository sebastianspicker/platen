import assert from 'node:assert/strict';
import { createServer, request as sendRequest } from 'node:http';
import test from 'node:test';
import { createAppHandler } from '../../src/host/transport/http/router.mjs';

const token = 't'.repeat(48);

function request(port, { method = 'GET', path = '/api/bootstrap', headers = {}, body = undefined, setHost = true } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const client = sendRequest({ host: '127.0.0.1', port, method, path, headers, setHost }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body }));
    });
    client.once('error', rejectRequest);
    client.end(body);
  });
}

async function startLocalApp(overrides = {}) {
  let app;
  let staticRequests = 0;
  const server = createServer((incoming, outgoing) => app(incoming, outgoing));
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  app = createAppHandler({
    staticHandler: (_request, response) => {
      staticRequests += 1;
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('static-only');
    },
    store: {}, service: { availability: async () => [] }, workspaceState: {},
    token, host: '127.0.0.1', port,
    ...overrides,
  });
  return {
    port,
    staticRequests: () => staticRequests,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose()))),
  };
}

function errorCode(response) {
  return JSON.parse(response.body).error.code;
}

test('local bootstrap and mutation guards hold on an actual loopback HTTP server', async (t) => {
  const local = await startLocalApp();
  t.after(local.close);
  const exactHost = `127.0.0.1:${local.port}`;
  const exactOrigin = `http://${exactHost}`;

  const wrongHost = await request(local.port, { headers: { host: `evil.example:${local.port}` } });
  assert.equal(wrongHost.status, 421);
  assert.equal(errorCode(wrongHost), 'MISDIRECTED_REQUEST');
  assert.doesNotMatch(wrongHost.body, /sessionToken/);
  assert.equal(local.staticRequests(), 0, 'API traffic must not fall through to static serving');

  const missingHost = await request(local.port, { setHost: false });
  assert.equal(missingHost.status, 400, 'Node rejects an HTTP/1.1 request without Host before application dispatch');
  assert.doesNotMatch(missingHost.body, /sessionToken/);

  const malformedHost = await request(local.port, { headers: { host: '127.0.0.1:not-a-port' } });
  assert.equal(malformedHost.status, 421);
  assert.equal(errorCode(malformedHost), 'MISDIRECTED_REQUEST');

  const crossSite = await request(local.port, { headers: {
    host: exactHost, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors',
  } });
  assert.equal(crossSite.status, 403);
  assert.equal(errorCode(crossSite), 'FETCH_CONTEXT_FORBIDDEN');
  assert.doesNotMatch(crossSite.body, /sessionToken/);

  const bootstrap = await request(local.port, { headers: { host: exactHost, 'sec-fetch-site': 'same-origin' } });
  assert.equal(bootstrap.status, 200);
  assert.equal(JSON.parse(bootstrap.body).sessionToken, token);

  const wrongToken = await request(local.port, { method: 'POST', path: '/api/unknown', headers: {
    host: exactHost, origin: exactOrigin, 'x-platen-token': 'wrong',
  } });
  assert.equal(wrongToken.status, 401);
  assert.equal(errorCode(wrongToken), 'UNAUTHORIZED');

  const wrongOrigin = await request(local.port, { method: 'POST', path: '/api/unknown', headers: {
    host: exactHost, origin: `http://localhost:${local.port}`, 'x-platen-token': token,
  } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(errorCode(wrongOrigin), 'ORIGIN_FORBIDDEN');

  const sameOriginMutation = await request(local.port, { method: 'POST', path: '/api/unknown', headers: {
    host: exactHost, origin: exactOrigin, 'x-platen-token': token,
  } });
  assert.equal(sameOriginMutation.status, 404, 'same-origin mutation must pass transport guards to API dispatch');
  assert.equal(errorCode(sameOriginMutation), 'NOT_FOUND');

  const staticResponse = await request(local.port, { path: '/', headers: { host: exactHost } });
  assert.equal(staticResponse.status, 200);
  assert.equal(staticResponse.body, 'static-only');
  assert.equal(local.staticRequests(), 1, 'only non-API paths may reach static serving');
});

test('authenticated document reads and source-bound mutations reach only their composed services', async (t) => {
  const documentId = '11111111-1111-4111-8111-111111111111';
  const sourceSha256 = 'a'.repeat(64);
  const calls = [];
  const store = {
    getDocument(id) {
      assert.equal(id, documentId);
      return { id: documentId, sha256: sourceSha256, mediaType: 'application/pdf' };
    },
    async verifySource(id) { calls.push(['verifySource', id]); },
    async deleteArtifact(id) { calls.push(['deleteArtifact', id]); },
  };
  const service = {
    availability: async () => [],
    async inspect(id) { calls.push(['inspect', id]); return { pageCount: 2, title: 'fixture' }; },
    async arrangePages(id, pages, options) {
      calls.push(['arrangePages', id, pages, options.sourceSha256]);
      return { id: 'retained-artifact' };
    },
  };
  const local = await startLocalApp({ store, service });
  t.after(local.close);
  const host = `127.0.0.1:${local.port}`;
  const authenticated = { host, 'x-platen-token': token };

  const rejectedRead = await request(local.port, { path: `/api/documents/${documentId}/inspection`, headers: { host } });
  assert.equal(rejectedRead.status, 401);
  assert.equal(errorCode(rejectedRead), 'UNAUTHORIZED');
  assert.deepEqual(calls, []);

  const read = await request(local.port, { path: `/api/documents/${documentId}/inspection`, headers: authenticated });
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), { inspection: { pageCount: 2, title: 'fixture' } });
  assert.deepEqual(calls, [['inspect', documentId]]);

  const mutation = await request(local.port, {
    method: 'POST',
    path: `/api/documents/${documentId}/delete`,
    headers: { ...authenticated, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sourceSha256, pages: [1] }),
  });
  assert.equal(mutation.status, 201);
  assert.deepEqual(JSON.parse(mutation.body), { artifact: { id: 'retained-artifact' } });
  assert.deepEqual(calls, [
    ['inspect', documentId],
    ['verifySource', documentId],
    ['inspect', documentId],
    ['arrangePages', documentId, [2], sourceSha256],
    ['verifySource', documentId],
  ]);
});
