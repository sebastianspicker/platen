import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalHostClient } from '../../src/browser/core/local-host-client.js';
import { PlatenError } from '../../src/contracts/errors.js';
import { startApplication } from '../../src/browser/bootstrap/application-bootstrap.js';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const token = 'f'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';

function response(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('browser client bootstraps a token, applies it to API reads, and rejects invalid local results', async () => {
  const calls = [];
  const client = new LocalHostClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') return response({ sessionToken: token, host: { localOnly: true }, engines: [] });
      if (path === `/api/documents/${documentId}/inspection`) return response({ inspection: { pageCount: 1 } });
      return response({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 });
    },
  });
  assert.equal(client.connected, false);
  assert.deepEqual(await client.bootstrap(), { host: { localOnly: true }, engines: [] });
  assert.equal(client.connected, true);
  assert.deepEqual(await client.inspect(documentId), { pageCount: 1 });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[1].options.credentials, 'omit');
  assert.throws(() => client.deletePages('not-an-opaque-id', 'a'.repeat(64), [1]), TypeError);

  const badClient = new LocalHostClient({ fetchImpl: async () => response({ sessionToken: 'short' }) });
  await assert.rejects(badClient.bootstrap(), (error) => error instanceof PlatenError && error.code === 'INVALID_LOCAL_HOST');
});

test('browser entrypoint remains a static bootstrap over the exported application initializer', () => {
  assert.equal(typeof startApplication, 'function');
  const entrypoint = readFileSync(join(repositoryRoot, 'src/browser/main.js'), 'utf8');
  assert.match(entrypoint, /import\s*\{\s*startApplication\s*\}\s*from\s*['"]\.\/bootstrap\/application-bootstrap\.js['"]/u);
  assert.match(entrypoint, /startApplication\(\);/u);
});
