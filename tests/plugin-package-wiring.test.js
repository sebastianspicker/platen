import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPluginPackageCommand } from '../scripts/cli/commands/plugin-package.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { handlePluginPlatformRoute } from '../scripts/host/routes/plugin-platform-routes.mjs';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { PluginPackageStore } from '../scripts/host/plugin-package-store.mjs';
import { TrustedPublisherStore, canonicalizePluginPackage, pluginPackageSignedPayload, sha256 } from '../scripts/host/plugin-package.mjs';
import { createPluginPackageEndpoints } from '../src/core/local-host-plugin-package-endpoints.js';

const keys = generateKeyPairSync('ed25519');
const pluginId = 'org.example.wired';

function packageValue(version = '1.0.0') {
  const content = Buffer.from('export default {};');
  const value = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 2, id: pluginId, name: 'Wired plugin', version,
      protocolVersion: 1, entry: 'index.mjs', capabilities: ['document.example'],
      permissions: [{ name: 'document.metadata', reason: 'Read metadata.' }],
      dependencies: [], activation: 'manual',
    },
    files: [{ path: 'index.mjs', mediaType: 'text/javascript', size: content.length, sha256: sha256(content), content: content.toString('base64') }],
    signature: { algorithm: 'ed25519', publisherId: 'org.example', keyId: 'wired', value: '' },
  };
  value.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(value)), keys.privateKey).toString('base64');
  return value;
}

function routeContext(overrides = {}) {
  const calls = [];
  return {
    pathname: '/api/plugin-packages',
    request: { method: 'GET' },
    response: {},
    url: new URL('http://127.0.0.1/api/plugin-packages'),
    processing: { signal: new AbortController().signal },
    pluginPackages: {
      listPlugins: () => [{ id: pluginId, activeVersion: null, previousVersion: null, versions: [] }],
      install: async (bytes) => { calls.push(Buffer.from(bytes)); return { id: pluginId, version: '1.0.0', digest: 'a'.repeat(64) }; },
      activate: async () => ({ id: pluginId, activeVersion: '1.0.0', previousVersion: null, versions: [] }),
      rollback: async () => ({ id: pluginId, activeVersion: '1.0.0', previousVersion: null, versions: [] }),
      getPlugin: () => ({ id: pluginId, activeVersion: '1.0.0', previousVersion: null, versions: [] }),
    },
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => ({}),
    readBytes: async () => Buffer.from('canonical-package-bytes'),
    requireContentType: () => {},
    json: (_response, status, value) => { calls.push({ status, value }); },
    ...overrides,
    calls,
  };
}

test('plugin package parser requires explicit roots and action-specific fields', () => {
  assert.deepEqual(parseCliArguments(['admin.plugin-package', '--action', 'list', '--plugin-root', 'packages', '--trust-root', 'trust', '--policy-root', 'policy']), {
    command: 'admin.plugin-package', action: 'list', pluginRoot: 'packages', trustRoot: 'trust', policyRoot: 'policy', output: null,
  });
  assert.deepEqual(parseCliArguments(['admin.plugin-package', '--action', 'install', '--plugin-root', 'packages', '--trust-root', 'trust', '--policy-root', 'policy', '--package', 'package.json']), {
    command: 'admin.plugin-package', action: 'install', pluginRoot: 'packages', trustRoot: 'trust', policyRoot: 'policy', packagePath: 'package.json', output: null,
  });
  assert.deepEqual(parseCliArguments(['admin.plugin-package', '--action', 'activate', '--plugin-root', 'packages', '--trust-root', 'trust', '--policy-root', 'policy', '--plugin-id', pluginId, '--version', '1.0.0']).version, '1.0.0');
  assert.throws(() => parseCliArguments(['admin.plugin-package', '--action', 'list', '--trust-root', 'trust']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['admin.plugin-package', '--action', 'list', '--plugin-root', 'packages', '--trust-root', 'trust']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['admin.plugin-package', '--action', 'rollback', '--plugin-root', 'packages', '--trust-root', 'trust', '--policy-root', 'policy', '--plugin-id', pluginId, '--version', '1.0.0']), { code: 'CLI_INVALID_OPTION' });
});

test('plugin package lifecycle route enforces method/query boundaries and preserves install bytes', async () => {
  const list = routeContext();
  assert.equal(await handlePluginPlatformRoute(list), true);
  assert.deepEqual(list.calls[0].value.plugins[0].id, pluginId);
  const install = routeContext({
    pathname: '/api/plugin-packages/install',
    request: { method: 'POST' },
    url: new URL('http://127.0.0.1/api/plugin-packages/install'),
  });
  await handlePluginPlatformRoute(install);
  assert.equal(Buffer.isBuffer(install.calls[0]), true);
  assert.equal(install.calls[0].toString(), 'canonical-package-bytes');
  assert.equal(install.calls[1].status, 201);
  const invalidQuery = routeContext({ url: new URL('http://127.0.0.1/api/plugin-packages?extra=1') });
  await assert.rejects(handlePluginPlatformRoute(invalidQuery), { code: 'INVALID_PARAMETER', status: 400 });
  const activation = routeContext({
    pathname: `/api/plugin-packages/${pluginId}/activate`,
    request: { method: 'POST' },
    url: new URL(`http://127.0.0.1/api/plugin-packages/${pluginId}/activate?version=1.0.0`),
  });
  await handlePluginPlatformRoute(activation);
  assert.equal(activation.calls[0].value.action, 'activate');
});

test('plugin package route exposes the real store summary without launch or manifest data', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-plugin-route-store-'));
  context.after(async () => {
    await chmod(join(root, 'packages'), 0o700).catch(() => {});
    for (const digest of await readdir(join(root, 'packages')).catch(() => [])) await chmod(join(root, 'packages', digest), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const publishers = new TrustedPublisherStore();
  publishers.enroll({ publisherId: 'org.example', keyId: 'wired', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), pluginIds: [pluginId] });
  const store = await new PluginPackageStore({ root, trustedPublishers: publishers }).initialize();
  const packageBytes = Buffer.from(canonicalizePluginPackage(packageValue()));
  const calls = [];
  const request = { method: 'POST' };
  const contextValue = {
    pathname: '/api/plugin-packages/install', request, response: {}, url: new URL('http://127.0.0.1/api/plugin-packages/install'),
    processing: { signal: new AbortController().signal }, pluginPackages: store,
    method: (actual, expected) => assert.equal(actual.method, expected), readJson: async () => ({}),
    readBytes: async () => Buffer.from(packageBytes), requireContentType: () => {},
    json: (_response, status, value) => calls.push({ status, value }),
  };
  await handlePluginPlatformRoute(contextValue);
  assert.equal(calls[0].value.result.id, pluginId);
  contextValue.pathname = `/api/plugin-packages/${pluginId}/activate`;
  contextValue.url = new URL(`http://127.0.0.1/api/plugin-packages/${pluginId}/activate?version=1.0.0`);
  await handlePluginPlatformRoute(contextValue);
  const activation = calls[1].value.result;
  assert.equal(activation.activeVersion, '1.0.0');
  assert.equal(Object.hasOwn(activation, 'manifest'), false);
  assert.equal(Object.hasOwn(activation, 'packageRoot'), false);
});

test('plugin package client validates lifecycle results and sends exact raw package bytes', async () => {
  const calls = [];
  const endpoints = createPluginPackageEndpoints({
    request: async (path, options) => {
      calls.push({ path, options });
      const body = path === '/api/plugin-packages'
        ? { plugins: [{ id: pluginId, activeVersion: null, previousVersion: null, versions: [] }] }
        : { action: path.endsWith('/install') ? 'install' : 'activate', localOnly: true, result: path.endsWith('/install') ? { id: pluginId, version: '1.0.0', digest: 'a'.repeat(64) } : { id: pluginId, activeVersion: '1.0.0', previousVersion: null, versions: [] } };
      return { json: async () => body };
    },
  });
  assert.equal((await endpoints.listPluginPackages()).length, 1);
  const bytes = Buffer.from('signed-canonical-bytes');
  assert.equal((await endpoints.installPluginPackage(bytes)).id, pluginId);
  assert.equal((await endpoints.activatePluginPackage(pluginId, '1.0.0')).activeVersion, '1.0.0');
  assert.equal(calls[1].options.body.toString(), 'signed-canonical-bytes');
  assert.throws(() => endpoints.activatePluginPackage(pluginId, '1.0'), TypeError);
});

test('plugin package CLI executes list, install, activate, and rollback with cancellation gates', async () => {
  const calls = [];
  const auditCalls = [];
  const application = { adminAudit: { append: async (value) => auditCalls.push(value) }, pluginPackages: {
    listPlugins: () => [{ id: pluginId, activeVersion: null, previousVersion: null, versions: [] }],
    install: async (bytes) => { calls.push(['install', bytes.toString()]); return { id: pluginId, version: '1.0.0', digest: 'a'.repeat(64) }; },
    activate: async (id, version) => { calls.push(['activate', id, version]); return { id, activeVersion: version, previousVersion: null, versions: [] }; },
    rollback: async (id) => { calls.push(['rollback', id]); return { id, activeVersion: '1.0.0', previousVersion: null, versions: [] }; },
    getPlugin: (id) => ({ id, activeVersion: '1.0.0', previousVersion: null, versions: [] }),
  } };
  const output = [];
  const runtime = {
    cancelled: () => {},
    readLocalInputBytes: async () => ({ bytes: Buffer.from('raw-package') }),
    outputValue: async (_command, _stdout, value) => output.push(value),
    fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  };
  await runPluginPackageCommand(application, { action: 'list' }, null, null, runtime);
  await runPluginPackageCommand(application, { action: 'install', packagePath: 'package.json' }, null, null, runtime);
  await runPluginPackageCommand(application, { action: 'activate', pluginId, version: '1.0.0' }, null, null, runtime);
  await runPluginPackageCommand(application, { action: 'rollback', pluginId }, null, null, runtime);
  assert.deepEqual(calls.map(([name]) => name), ['install', 'activate', 'rollback']);
  assert.deepEqual(auditCalls.map(({ action }) => action), [
    'package.install', 'package.activate', 'package.rollback',
  ]);
  assert.equal(auditCalls.every(({ outcome }) => outcome === 'succeeded'), true);
  assert.equal(output.length, 4);
});

test('local application persists package lifecycle state and composes runtime termination transitions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-plugin-wiring-'));
  const packageRoot = join(root, 'packages');
  const trustRoot = join(root, 'trust');
  context.after(async () => {
    await chmod(join(packageRoot, 'packages'), 0o700).catch(() => {});
    for (const digest of await readdir(join(packageRoot, 'packages')).catch(() => [])) {
      await chmod(join(packageRoot, 'packages', digest), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const app = await createLocalApplication({ root: process.cwd(), pluginPackageRoot: packageRoot, publisherTrustRoot: trustRoot, token: 'a'.repeat(64) });
  context.after(() => app.close());
  await app.trustedPublishers.enroll({
    publisherId: 'org.example', keyId: 'wired',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), pluginIds: [pluginId],
  });
  const first = await app.pluginPackages.install(packageValue('1.0.0'));
  await app.pluginPackages.install(packageValue('2.0.0'));
  await app.pluginPackages.activate(pluginId, '1.0.0');
  let terminated = 0;
  await app.pluginRuntimeAuthorities.register({
    binding: {
      pluginId, version: '1.0.0', packageHash: first.digest,
      activationId: 'activation_wired_abcdefghijkl', operationId: 'operation_wired_abcdefghijk', nonce: 'b'.repeat(64),
    },
    terminate: async () => { terminated += 1; },
  });
  await app.pluginPackages.activate(pluginId, '2.0.0');
  assert.equal(terminated, 1);
  await app.close();
  const restored = await createLocalApplication({ root: process.cwd(), pluginPackageRoot: packageRoot, publisherTrustRoot: trustRoot, token: 'b'.repeat(64) });
  context.after(() => restored.close());
  assert.equal(restored.pluginPackages.getPlugin(pluginId).activeVersion, '2.0.0');
});
