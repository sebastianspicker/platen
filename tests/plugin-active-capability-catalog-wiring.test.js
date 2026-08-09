import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectActivePluginCapabilityCatalog } from '../scripts/host/plugin-active-capability-catalog.mjs';
import {
  TrustedPublisherStore,
  pluginPackageSignedPayload,
  sha256,
} from '../scripts/host/plugin-package.mjs';
import { PluginPackageStore } from '../scripts/host/plugin-package-store.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { capabilityCatalog } from '../src/core/local-host-plugin-package-endpoints.js';
import { invoke } from './support/host-router-fixture-base.js';

const executablePluginId = 'org.example.catalog-executable';
const conflictPluginId = 'org.example.catalog-conflict';
const metadataPluginId = 'org.example.catalog-metadata';
const routeToken = 'a'.repeat(64);
const keys = generateKeyPairSync('ed25519');

function signPackage(value) {
  value.signature.value = sign(
    null,
    Buffer.from(pluginPackageSignedPayload(value)),
    keys.privateKey,
  ).toString('base64');
  return value;
}

function executablePackage() {
  const content = Buffer.from('throw new Error("catalog collection must not execute plugin source");');
  return signPackage({
    packageVersion: 1,
    manifest: {
      manifestVersion: 3,
      id: executablePluginId,
      name: 'Catalog executable plugin',
      version: '1.0.0',
      protocolVersion: 1,
      entry: 'index.js',
      capabilities: ['document.catalog', 'ui.catalog'],
      permissions: [{ name: 'document.metadata', reason: 'Read local document metadata.' }],
      dependencies: [],
      activation: 'manual',
      runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 },
    },
    files: [{
      path: 'index.js',
      mediaType: 'text/javascript',
      size: content.length,
      sha256: sha256(content),
      content: content.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519',
      publisherId: 'org.example',
      keyId: 'catalog-test',
      value: '',
    },
  });
}

function conflictPackage() {
  const content = Buffer.from('globalThis.catalogConflictPlugin = true;');
  return signPackage({
    packageVersion: 1,
    manifest: {
      manifestVersion: 3,
      id: conflictPluginId,
      name: 'Catalog conflict plugin',
      version: '1.0.0',
      protocolVersion: 1,
      entry: 'index.js',
      capabilities: ['document.catalog'],
      permissions: [{ name: 'document.metadata', reason: 'Read local document metadata.' }],
      dependencies: [],
      activation: 'manual',
      runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 },
    },
    files: [{
      path: 'index.js',
      mediaType: 'text/javascript',
      size: content.length,
      sha256: sha256(content),
      content: content.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519',
      publisherId: 'org.example',
      keyId: 'catalog-test',
      value: '',
    },
  });
}

function metadataPackage() {
  const content = Buffer.from('export default {};');
  return signPackage({
    packageVersion: 1,
    manifest: {
      manifestVersion: 2,
      id: metadataPluginId,
      name: 'Catalog metadata plugin',
      version: '1.0.0',
      protocolVersion: 1,
      entry: 'index.mjs',
      capabilities: ['document.metadata-only'],
      permissions: [{ name: 'document.metadata', reason: 'Read local document metadata.' }],
      dependencies: [],
      activation: 'manual',
    },
    files: [{
      path: 'index.mjs',
      mediaType: 'text/javascript',
      size: content.length,
      sha256: sha256(content),
      content: content.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519',
      publisherId: 'org.example',
      keyId: 'catalog-test',
      value: '',
    },
  });
}

async function realStore(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-plugin-capability-catalog-'));
  context.after(async () => {
    await chmod(join(root, 'packages'), 0o700).catch(() => {});
    for (const digest of await readdir(join(root, 'packages')).catch(() => [])) {
      await chmod(join(root, 'packages', digest), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const publishers = new TrustedPublisherStore();
  publishers.enroll({
    publisherId: 'org.example',
    keyId: 'catalog-test',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    pluginIds: [conflictPluginId, executablePluginId, metadataPluginId],
  });
  const store = await new PluginPackageStore({ root, trustedPublishers: publishers }).initialize();
  const executable = await store.install(executablePackage());
  await store.install(conflictPackage());
  await store.install(metadataPackage());
  await store.activate(executablePluginId, '1.0.0');
  await store.activate(conflictPluginId, '1.0.0');
  await store.activate(metadataPluginId, '1.0.0');
  return { executable, root, store };
}

function createHandler(pluginPackages) {
  return createAppHandler({
    staticHandler: () => {},
    store: {
      deleteArtifact: async () => {},
      getDocument: () => null,
      verifySource: async () => {},
    },
    service: { availability: async () => [] },
    workspaceState: {},
    pluginPackages,
    token: routeToken,
    host: '127.0.0.1',
    port: 4173,
  });
}

function handlerFetch(handler) {
  return async (path, options = {}) => {
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const response = await invoke(handler, {
      method: options.method ?? 'GET',
      url: path,
      headers: { origin: 'http://127.0.0.1:4173', ...headers },
      body: options.body ?? '',
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
}

test('authenticated route and client list only active signed executable package capabilities', async (context) => {
  const { store } = await realStore(context);
  let authorityCalls = 0;
  const authority = {
    listPlugins() {
      authorityCalls += 1;
      return store.listPlugins();
    },
    async getLaunchDescriptor(id) {
      authorityCalls += 1;
      return store.getLaunchDescriptor(id);
    },
  };
  const handler = createHandler(authority);

  const unauthorized = await invoke(handler, {
    method: 'GET',
    url: '/api/plugin-capability-catalog',
    headers: { origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(authorityCalls, 0);

  const client = new LocalHostClient({ fetchImpl: handlerFetch(handler) });
  await client.bootstrap();
  const catalog = await client.listActivePluginCapabilities();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.kind, 'active-plugin-capability-catalog');
  assert.equal(catalog.localOnly, true);
  assert.equal(catalog.executablePackagesOnly, true);
  assert.equal(catalog.catalogOnlyExecution, true);
  assert.equal(catalog.conflictResolution, 'lexicographic-plugin-id');
  assert.equal(catalog.conflictCount, 1);
  assert.deepEqual(catalog.conflicts, [{
    capabilityId: 'document.catalog',
    providerIds: [conflictPluginId, executablePluginId],
    selectedProviderId: conflictPluginId,
  }]);
  assert.equal(catalog.count, 2);
  assert.deepEqual(catalog.packageIds, [conflictPluginId, executablePluginId]);
  assert.deepEqual(catalog.packages.map((entry) => entry.capabilities), [
    ['document.catalog'], ['document.catalog', 'ui.catalog'],
  ]);
  assert.equal(catalog.packages[0].manifestVersion, 3);
  assert.equal(Object.hasOwn(catalog.packages[0], 'packageRoot'), false);
  assert.equal(Object.hasOwn(catalog.packages[0], 'entryPath'), false);
  assert.equal(Object.hasOwn(catalog.packages[0], 'executableRuntime'), false);
  assert.equal(JSON.stringify(catalog).includes('must not execute plugin source'), false);
  assert.equal(Object.isFrozen(catalog.packages[0].capabilities), true);
  assert.equal(Object.isFrozen(catalog.conflicts), true);
  assert.equal(Object.isFrozen(catalog.conflicts[0]), true);
  assert.equal(Object.isFrozen(catalog.conflicts[0].providerIds), true);
  assert.equal(authorityCalls, 4);
});

test('real package store integrity verification rejects tampered active source bytes', async (context) => {
  const { executable, root, store } = await realStore(context);
  assert.equal((await collectActivePluginCapabilityCatalog(store)).count, 2);
  const entryPath = join(root, 'packages', executable.digest, 'index.js');
  await chmod(entryPath, 0o600);
  await writeFile(entryPath, 'globalThis.catalogTampered = true;', 'utf8');
  await assert.rejects(
    collectActivePluginCapabilityCatalog(store),
    { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 },
  );
});

test('client catalog validator rejects mismatched identifiers and extra wire fields', () => {
  const packageValue = {
    id: executablePluginId,
    version: '1.0.0',
    digest: 'a'.repeat(64),
    name: 'Catalog executable plugin',
    activation: 'manual',
    manifestVersion: 3,
    protocolVersion: 1,
    capabilities: ['document.catalog'],
    publisher: { publisherId: 'org.example', keyId: 'catalog-test' },
  };
  const valid = {
    schemaVersion: 1,
    kind: 'active-plugin-capability-catalog',
    localOnly: true,
    executablePackagesOnly: true,
    catalogOnlyExecution: true,
    count: 1,
    packageIds: [executablePluginId],
    packages: [packageValue],
    conflictResolution: 'lexicographic-plugin-id',
    conflictCount: 0,
    conflicts: [],
  };
  assert.equal(capabilityCatalog(valid).count, 1);
  assert.throws(() => capabilityCatalog({ ...valid, packageIds: [metadataPluginId] }), TypeError);
  assert.throws(() => capabilityCatalog({ ...valid, unexpected: true }), TypeError);

  const secondPackage = {
    ...packageValue,
    id: conflictPluginId,
    digest: 'b'.repeat(64),
    name: 'Catalog conflict plugin',
  };
  const conflicting = {
    ...valid,
    count: 2,
    packageIds: [conflictPluginId, executablePluginId],
    packages: [secondPackage, packageValue],
    conflictCount: 1,
    conflicts: [{
      capabilityId: 'document.catalog',
      providerIds: [conflictPluginId, executablePluginId],
      selectedProviderId: conflictPluginId,
    }],
  };
  const frozen = capabilityCatalog(conflicting);
  assert.equal(Object.isFrozen(frozen.conflicts), true);
  assert.equal(Object.isFrozen(frozen.conflicts[0]), true);
  assert.equal(Object.isFrozen(frozen.conflicts[0].providerIds), true);
  assert.throws(() => { frozen.conflicts[0].providerIds.push('org.example.other'); });
  assert.throws(() => capabilityCatalog({ ...conflicting, conflictCount: 0, conflicts: [] }), TypeError);
  assert.throws(() => capabilityCatalog({
    ...conflicting,
    conflicts: [{ ...conflicting.conflicts[0], providerIds: [executablePluginId, conflictPluginId], selectedProviderId: executablePluginId }],
  }), TypeError);
  assert.throws(() => capabilityCatalog({
    ...conflicting,
    conflicts: [{ ...conflicting.conflicts[0], providerIds: [conflictPluginId], selectedProviderId: conflictPluginId }],
  }), TypeError);
  assert.throws(() => capabilityCatalog({
    ...conflicting,
    conflicts: [{ ...conflicting.conflicts[0], providerIds: [conflictPluginId, executablePluginId], selectedProviderId: executablePluginId }],
  }), TypeError);
});
