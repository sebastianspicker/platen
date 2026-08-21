import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAppHandler } from '../scripts/host/router.mjs';

class Response extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.status = null;
    this.body = '';
  }

  writeHead(status) { this.status = status; }

  end(body = '') {
    this.body += body;
    this.writableEnded = true;
  }
}

function request({ method = 'GET', url = '/api/bootstrap', headers = {} } = {}) {
  return Object.assign(new EventEmitter(), { method, url, headers });
}

function handler() {
  return createAppHandler({
    staticHandler: () => { throw new Error('API request reached static handler'); },
    store: {}, service: { availability: async () => [] }, workspaceState: {},
    token: 't'.repeat(48), host: '127.0.0.1', port: 4317,
  });
}

test('local bootstrap and mutation guards keep session authority on the exact loopback origin', async () => {
  const app = handler();
  const invoke = async (options) => {
    const response = new Response();
    await app(request(options), response);
    return response;
  };

  const wrongHost = await invoke({ headers: { host: 'evil.example:4317' } });
  assert.equal(wrongHost.status, 421);
  assert.doesNotMatch(wrongHost.body, /sessionToken/);

  const crossSite = await invoke({ headers: {
    host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors',
  } });
  assert.equal(crossSite.status, 403);
  assert.doesNotMatch(crossSite.body, /sessionToken/);

  const bootstrap = await invoke({ headers: {
    host: '127.0.0.1:4317', 'sec-fetch-site': 'same-origin',
  } });
  assert.equal(bootstrap.status, 200);
  const { sessionToken } = JSON.parse(bootstrap.body);
  assert.equal(sessionToken, 't'.repeat(48));

  const wrongToken = await invoke({ method: 'POST', url: '/api/unknown', headers: {
    host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-platen-token': 'wrong',
  } });
  assert.equal(wrongToken.status, 401);

  const wrongOrigin = await invoke({ method: 'POST', url: '/api/unknown', headers: {
    host: '127.0.0.1:4317', origin: 'http://localhost:4317', 'x-platen-token': sessionToken,
  } });
  assert.equal(wrongOrigin.status, 403);
});
