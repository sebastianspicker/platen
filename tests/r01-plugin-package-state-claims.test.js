import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handlePluginPlatformRoute } from '../scripts/host/routes/plugin-platform-routes.mjs';
import { PluginRuntimeAuthorityRegistry } from '../scripts/host/plugin-runtime-authority-registry.mjs';
import { resolvePinnedDependencyDag } from '../scripts/host/plugin-package-store.mjs';
import { PluginPackageStore } from '../scripts/host/plugin-package-store.mjs';
import {
  PACKAGE_IDS,
  createStore,
  packageBytes,
  packageDigest,
  removeStore,
  signedPackage,
  trustedPublishers,
} from './support/r01-plugin-package-state-fixtures.js';

function routeContext(store, pathname, { bytes = null, signal = new AbortController().signal } = {}) {
  const calls = [];
  const url = new URL(`http://127.0.0.1${pathname}`);
  pathname = url.pathname;
  const methodName = pathname === '/api/plugin-packages' ? 'GET' : 'POST';
  return {
    pathname,
    request: { method: methodName },
    response: {},
    url,
    processing: { signal },
    pluginPackages: store,
    method(request, expected) { assert.equal(request.method, expected); },
    readJson: async () => ({}),
    readBytes: async () => Buffer.from(bytes),
    requireContentType() {},
    json(_response, status, value) { calls.push({ status, value }); },
    calls,
  };
}

function binding(digest, version = '1.0.0') {
  return {
    pluginId: PACKAGE_IDS.root,
    version,
    packageHash: digest,
    activationId: 'activation_r01_abcdefghijkl',
    operationId: 'operation_r01_abcdefghijkl',
    nonce: 'a'.repeat(64),
  };
}

test('platform.plugins.install and registry use the real route, signed bytes, durable reopen, and safe inventory', async (t) => {
  const { root, publishers, store } = await createStore(t);
  const child = signedPackage({ id: PACKAGE_IDS.child });
  const childDigest = packageDigest(child, publishers);
  await store.install(child);
  const rootPackage = signedPackage({
    dependencies: [{ id: PACKAGE_IDS.child, version: '1.0.0', digest: childDigest }],
  });
  const install = routeContext(store, '/api/plugin-packages/install', { bytes: packageBytes(rootPackage) });
  assert.equal(await handlePluginPlatformRoute(install), true);
  assert.equal(install.calls[0].status, 201);
  assert.equal(install.calls[0].value.result.id, PACKAGE_IDS.root);
  assert.equal(install.calls[0].value.result.version, '1.0.0');
  assert.equal(install.calls[0].value.localOnly, true);

  const activate = routeContext(store, `/api/plugin-packages/${PACKAGE_IDS.root}/activate?version=1.0.0`);
  await handlePluginPlatformRoute(activate);
  assert.equal(activate.calls[0].value.result.activeVersion, '1.0.0');
  assert.equal(Object.hasOwn(activate.calls[0].value.result, 'packageRoot'), false);
  assert.equal(Object.hasOwn(activate.calls[0].value.result, 'manifest'), false);

  const list = routeContext(store, '/api/plugin-packages');
  await handlePluginPlatformRoute(list);
  const summary = list.calls[0].value.plugins.find(({ id }) => id === PACKAGE_IDS.root);
  assert.deepEqual(Object.keys(summary).sort(), ['activeVersion', 'id', 'previousVersion', 'versions']);
  assert.equal(summary.versions.length, 1);
  assert.equal(Object.hasOwn(summary.versions[0], 'packageRoot'), false);

  const reopened = await new PluginPackageStore({ root, trustedPublishers: publishers }).initialize();
  assert.equal(reopened.getPlugin(PACKAGE_IDS.root).activeVersion, '1.0.0');
  assert.equal((await reopened.getActivation(PACKAGE_IDS.root)).dependencies[0].digest, childDigest);
});

test('platform.plugins.lifecycle and upgrade-rollback terminate registered runtime before durable transitions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-r01-transition-'));
  t.after(() => removeStore(root));
  const publishers = trustedPublishers();
  let packages;
  let authorities;
  packages = new PluginPackageStore({
    root,
    trustedPublishers: publishers,
    activationTransition: (transition) => authorities.transition(transition),
  });
  authorities = new PluginRuntimeAuthorityRegistry({ resolveActivation: (id) => packages.getActivation(id) });
  await packages.initialize();
  const first = await packages.install(signedPackage({ version: '1.0.0' }));
  await packages.install(signedPackage({ version: '2.0.0' }));
  await packages.activate(PACKAGE_IDS.root, '1.0.0');
  let terminated = 0;
  await authorities.register({ binding: binding(first.digest), terminate: async () => { terminated += 1; } });
  await assert.rejects(authorities.register({ binding: binding(first.digest), terminate: async () => {} }), { code: 'PLUGIN_ACTIVATION_DUPLICATE' });
  await packages.activate(PACKAGE_IDS.root, '2.0.0');
  assert.equal(terminated, 1);
  assert.equal(packages.getPlugin(PACKAGE_IDS.root).activeVersion, '2.0.0');
  assert.equal(authorities.activeCount, 0);
  await assert.rejects(packages.activate(PACKAGE_IDS.root, '1.0.0', { allowDowngrade: true }), { code: 'PACKAGE_DOWNGRADE_REJECTED' });
  const rollback = routeContext(packages, `/api/plugin-packages/${PACKAGE_IDS.root}/rollback`);
  await handlePluginPlatformRoute(rollback);
  assert.equal(rollback.calls[0].value.result.activeVersion, '1.0.0');
  assert.equal(rollback.calls[0].value.result.previousVersion, '2.0.0');
});

test('platform.plugins.dependency-resolution enforces exact signed DAG identities and hostile graphs', async (t) => {
  const { publishers, store } = await createStore(t);
  const child = signedPackage({ id: PACKAGE_IDS.child });
  const childDigest = packageDigest(child, publishers);
  await store.install(child);
  await store.install(signedPackage({ dependencies: [{ id: PACKAGE_IDS.child, version: '1.0.0', digest: childDigest }] }));
  await store.activate(PACKAGE_IDS.root, '1.0.0');
  const activation = await store.getActivation(PACKAGE_IDS.root);
  assert.deepEqual(activation.dependencies, [{ id: PACKAGE_IDS.child, version: '1.0.0', digest: childDigest }]);

  const missing = signedPackage({ id: PACKAGE_IDS.conflict, dependencies: [{ id: PACKAGE_IDS.child, version: '9.0.0', digest: 'b'.repeat(64) }] });
  await store.install(missing);
  await assert.rejects(store.activate(PACKAGE_IDS.conflict, '1.0.0'), { code: 'PACKAGE_DEPENDENCY_MISSING' });
  const cycle = new Map([
    ['org.example.a@1.0.0#' + 'a'.repeat(64), { digest: 'a'.repeat(64), manifest: { id: 'org.example.a', version: '1.0.0', dependencies: [{ id: 'org.example.b', version: '1.0.0', digest: 'b'.repeat(64) }] } }],
    ['org.example.b@1.0.0#' + 'b'.repeat(64), { digest: 'b'.repeat(64), manifest: { id: 'org.example.b', version: '1.0.0', dependencies: [{ id: 'org.example.a', version: '1.0.0', digest: 'a'.repeat(64) }] } }],
  ]);
  await assert.rejects(resolvePinnedDependencyDag({ id: 'org.example.a', version: '1.0.0', digest: 'a'.repeat(64) }, async (request) => cycle.get(`${request.id}@${request.version}#${request.digest}`)), { code: 'PACKAGE_DEPENDENCY_CYCLE' });
});

test('platform.plugins.install and registry fail closed on cancellation, replay conflict, tamper, and corruption', async (t) => {
  const { root, publishers, store } = await createStore(t);
  const value = signedPackage({ id: PACKAGE_IDS.conflict });
  const cancelled = new AbortController();
  cancelled.abort();
  const route = routeContext(store, '/api/plugin-packages/install', { bytes: packageBytes(value), signal: cancelled.signal });
  await assert.rejects(handlePluginPlatformRoute(route), { code: 'JOB_CANCELLED' });
  assert.equal(store.listPlugins().length, 0);

  const first = await store.install(value);
  await store.install(value);
  assert.equal(store.getPlugin(PACKAGE_IDS.conflict).versions.length, 1);
  await assert.rejects(store.install(signedPackage({ id: PACKAGE_IDS.conflict, content: 'different signed bytes' })), { code: 'PACKAGE_VERSION_CONFLICT' });
  await chmod(join(root, 'packages', first.digest, 'index.mjs'), 0o600);
  await writeFile(join(root, 'packages', first.digest, 'index.mjs'), 'tampered');
  await assert.rejects(store.activate(PACKAGE_IDS.conflict, '1.0.0'), { code: 'PACKAGE_INTEGRITY_FAILED' });
  await writeFile(join(root, 'registry.json'), JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(new PluginPackageStore({ root, trustedPublishers: publishers }).initialize(), { code: 'PACKAGE_REGISTRY_INVALID' });
  assert.equal((await readFile(join(root, 'registry.json'), 'utf8')).includes('plugins'), false);
});
