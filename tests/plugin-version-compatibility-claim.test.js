import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalizePluginPackage,
  pluginPackageSignedPayload,
  sha256,
  TrustedPublisherStore,
  verifyPluginPackage,
} from '../scripts/host/plugin-package.mjs';
import { PluginPackageStore, resolvePinnedDependencyDag } from '../scripts/host/plugin-package-store.mjs';

const keyPair = generateKeyPairSync('ed25519');
const trustedPublicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' });

function trust(pluginIds = ['org.example.plugin']) {
  const trusted = new TrustedPublisherStore();
  trusted.enroll({
    publisherId: 'org.example',
    keyId: 'test-key',
    publicKey: trustedPublicKey,
    pluginIds,
  });
  return trusted;
}

function packageRoot() {
  return mkdtempSync(join(tmpdir(), 'pdf-plugin-version-compatibility-'));
}

function signedPackage({
  manifestVersion = 2,
  id = 'org.example.plugin',
  version = '1.0.0',
  dependencies = [],
  source = 'export default {};',
} = {}) {
  const entry = manifestVersion === 3 ? 'index.js' : 'index.mjs';
  const content = Buffer.from(source);
  const manifest = {
    manifestVersion,
    id,
    name: 'Example plugin',
    version,
    protocolVersion: 1,
    entry,
    capabilities: ['document.metadata'],
    permissions: [{ name: 'document.metadata', reason: 'Read document metadata locally.' }],
    dependencies,
    activation: 'manual',
  };
  if (manifestVersion === 3) {
    manifest.runtime = { kind: 'javascriptcore-classic-script', apiVersion: 1 };
  }

  const value = {
    packageVersion: 1,
    manifest,
    files: [{
      path: entry,
      mediaType: 'text/javascript',
      size: content.length,
      sha256: sha256(content),
      content: content.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519',
      publisherId: 'org.example',
      keyId: 'test-key',
      value: '',
    },
  };
  value.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(value)), keyPair.privateKey).toString('base64');
  return value;
}

function reSign(pluginPackage) {
  pluginPackage.signature.value = sign(
    null,
    Buffer.from(pluginPackageSignedPayload(pluginPackage)),
    keyPair.privateKey,
  ).toString('base64');
  return pluginPackage;
}

function canonicalBytes(pluginPackage) {
  return Buffer.from(canonicalizePluginPackage(pluginPackage), 'utf8');
}

function differentDigest(digest) {
  return `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
}

function assertPluginInactive(store, pluginId) {
  const plugin = store.getPlugin(pluginId);
  assert.equal(plugin.activeVersion, null);
  assert.equal(plugin.previousVersion, null);
}

async function createStore(context, pluginIds) {
  const root = packageRoot();
  context.after(async () => {
    for (const digest of await readdir(join(root, 'packages')).catch(() => [])) {
      await chmod(join(root, 'packages', digest), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  });
  const trustedPublishers = trust(pluginIds);
  const store = await new PluginPackageStore({ root, trustedPublishers }).initialize();
  return { trustedPublishers, store };
}

test('supports valid manifest-v2 metadata and manifest-v3 executable installs', async (context) => {
  const { store, trustedPublishers } = await createStore(context, [
    'org.example.metadata',
    'org.example.executable',
  ]);

  const metadata = signedPackage({
    manifestVersion: 2,
    id: 'org.example.metadata',
    source: 'export const metadata = true;',
  });
  const executable = signedPackage({
    manifestVersion: 3,
    id: 'org.example.executable',
    source: 'globalThis.pluginReady = true;',
  });
  const metadataIdentity = verifyPluginPackage(metadata, trustedPublishers);
  const executableIdentity = verifyPluginPackage(executable, trustedPublishers);

  const metadataInstall = await store.install(canonicalBytes(metadata));
  const executableInstall = await store.install(canonicalBytes(executable));

  assert.equal(metadataInstall.id, metadataIdentity.manifest.id);
  assert.equal(metadataInstall.version, metadataIdentity.manifest.version);
  assert.equal(metadataInstall.digest, metadataIdentity.digest);
  assert.equal(executableInstall.id, executableIdentity.manifest.id);
  assert.equal(executableInstall.version, executableIdentity.manifest.version);
  assert.equal(executableInstall.digest, executableIdentity.digest);

  const plugins = store.listPlugins();
  assert.equal(plugins.length, 2);
  assert.equal(plugins[0].versions[0].version, '1.0.0');
  assert.equal(plugins[1].versions[0].version, '1.0.0');
});

test('installation rejects unsupported manifest and runtime compatibility values without registry mutation', async (context) => {
  const { store } = await createStore(context, [
    'org.example.versioned',
    'org.example.runtime',
  ]);

  const before = store.listPlugins();

  const unsupportedManifestVersion = signedPackage({
    manifestVersion: 2,
    id: 'org.example.versioned',
  });
  unsupportedManifestVersion.manifest.manifestVersion = 99;
  reSign(unsupportedManifestVersion);

  const unsupportedProtocolVersion = signedPackage({
    manifestVersion: 2,
    id: 'org.example.versioned',
  });
  unsupportedProtocolVersion.manifest.protocolVersion = 2;
  reSign(unsupportedProtocolVersion);

  const invalidRuntimeKind = signedPackage({
    manifestVersion: 3,
    id: 'org.example.runtime',
    source: 'globalThis.pluginReady = true;',
  });
  invalidRuntimeKind.manifest.runtime.kind = 'webview-script';
  reSign(invalidRuntimeKind);

  const invalidRuntimeApi = signedPackage({
    manifestVersion: 3,
    id: 'org.example.runtime',
    source: 'globalThis.pluginReady = true;',
  });
  invalidRuntimeApi.manifest.runtime.apiVersion = 2;
  reSign(invalidRuntimeApi);

  await assert.rejects(store.install(canonicalBytes(unsupportedManifestVersion)), {
    code: 'PACKAGE_MANIFEST_INVALID',
  });
  await assert.rejects(store.install(canonicalBytes(unsupportedProtocolVersion)), {
    code: 'PACKAGE_MANIFEST_INVALID',
  });
  await assert.rejects(store.install(canonicalBytes(invalidRuntimeKind)), {
    code: 'PACKAGE_RUNTIME_INVALID',
  });
  await assert.rejects(store.install(canonicalBytes(invalidRuntimeApi)), {
    code: 'PACKAGE_RUNTIME_INVALID',
  });

  assert.deepEqual(store.listPlugins(), before);
});

test('activation succeeds when metadata dependency identity is exact', async (context) => {
  const childId = 'org.example.child';
  const rootId = 'org.example.root';
  const { store, trustedPublishers } = await createStore(context, [childId, rootId]);

  const child = signedPackage({
    manifestVersion: 2,
    id: childId,
    source: 'export const child = true;',
  });
  const childIdentity = verifyPluginPackage(child, trustedPublishers);
  const root = signedPackage({
    manifestVersion: 2,
    id: rootId,
    source: 'export const root = true;',
    dependencies: [{
      id: childId,
      version: childIdentity.manifest.version,
      digest: childIdentity.digest,
    }],
  });

  await store.install(canonicalBytes(child));
  await store.install(canonicalBytes(root));
  const activation = await store.activate(rootId, '1.0.0');

  assert.equal(activation.version, '1.0.0');
  assert.equal(activation.manifest.id, rootId);
  assert.deepEqual(activation.dependencies, [{
    id: childId,
    version: '1.0.0',
    digest: childIdentity.digest,
  }]);
});

test('missing dependency fails before activation with no active-state mutation', async (context) => {
  const childId = 'org.example.child';
  const rootId = 'org.example.root';
  const { store } = await createStore(context, [childId, rootId]);

  const root = signedPackage({
    manifestVersion: 2,
    id: rootId,
    source: 'export const missingDependency = true;',
    dependencies: [{ id: childId, version: '1.0.0', digest: 'a'.repeat(64) }],
  });
  await store.install(canonicalBytes(root));

  await assert.rejects(store.activate(rootId, '1.0.0'), {
    code: 'PACKAGE_DEPENDENCY_MISSING',
    status: 424,
  });
  assertPluginInactive(store, rootId);
});

test('wrong dependency digest fails activation with no active-state mutation', async (context) => {
  const childId = 'org.example.dependency';
  const rootId = 'org.example.root';
  const { store, trustedPublishers } = await createStore(context, [childId, rootId]);

  const child = signedPackage({
    manifestVersion: 2,
    id: childId,
    source: 'export const dependency = 1;',
  });
  const childIdentity = verifyPluginPackage(child, trustedPublishers);
  await store.install(canonicalBytes(child));

  const root = signedPackage({
    manifestVersion: 2,
    id: rootId,
    source: 'export const wrongDigest = true;',
    dependencies: [{
      id: childId,
      version: childIdentity.manifest.version,
      digest: differentDigest(childIdentity.digest),
    }],
  });
  await store.install(canonicalBytes(root));
  await assert.rejects(store.activate(rootId, '1.0.0'), {
    code: 'PACKAGE_DEPENDENCY_MISMATCH',
    status: 409,
  });
  assertPluginInactive(store, rootId);
});

test('wrong dependency version fails activation with no active-state mutation', async (context) => {
  const childId = 'org.example.dependency';
  const rootId = 'org.example.root';
  const { store, trustedPublishers } = await createStore(context, [childId, rootId]);

  const childV1 = signedPackage({
    manifestVersion: 2,
    id: childId,
    version: '1.0.0',
    source: 'export const dependencyV1 = 1;',
  });
  const childV2 = signedPackage({
    manifestVersion: 2,
    id: childId,
    version: '2.0.0',
    source: 'export const dependencyV2 = 2;',
  });
  const childOne = verifyPluginPackage(childV1, trustedPublishers);
  const childTwo = verifyPluginPackage(childV2, trustedPublishers);
  await store.install(canonicalBytes(childV1));
  await store.install(canonicalBytes(childV2));

  const root = signedPackage({
    manifestVersion: 2,
    id: rootId,
    source: 'export const wrongVersion = true;',
    dependencies: [{
      id: childId,
      version: '1.0.0',
      digest: childTwo.digest,
    }],
  });
  await store.install(canonicalBytes(root));
  await assert.rejects(store.activate(rootId, '1.0.0'), {
    code: 'PACKAGE_DEPENDENCY_MISMATCH',
    status: 409,
  });
  assertPluginInactive(store, rootId);
});

test('shared pinned-dependency resolver rejects a cyclic graph', async () => {
  const rootId = 'org.example.root';
  const childId = 'org.example.cycle-child';
  const trustedPublishers = trust([rootId, childId]);

  const root = signedPackage({
    manifestVersion: 2,
    id: rootId,
    source: 'export const cycleRoot = true;',
    dependencies: [{ id: childId, version: '1.0.0', digest: 'a'.repeat(64) }],
  });
  const child = signedPackage({
    manifestVersion: 2,
    id: childId,
    source: 'export const cycleChild = true;',
  });

  const rootIdentity = verifyPluginPackage(root, trustedPublishers);
  const childIdentity = verifyPluginPackage(child, trustedPublishers);

  const graph = new Map([
    [`${rootId}:1.0.0`, {
      digest: rootIdentity.digest,
      manifest: {
        id: rootId,
        version: '1.0.0',
        dependencies: [{ id: childId, version: '1.0.0', digest: childIdentity.digest }],
      },
    }],
    [`${childId}:1.0.0`, {
      digest: childIdentity.digest,
      manifest: {
        id: childId,
        version: '1.0.0',
        dependencies: [{ id: rootId, version: '1.0.0', digest: rootIdentity.digest }],
      },
    }],
  ]);

  // Signed content-addressed packages cannot practically encode a mutually
  // self-consistent digest cycle. Exercise the exact resolver used by activation
  // directly so its defensive cycle branch remains deterministic and reachable.
  await assert.rejects(resolvePinnedDependencyDag({
    id: rootId,
    version: '1.0.0',
    digest: rootIdentity.digest,
  }, async (request) => graph.get(`${request.id}:${request.version}`)), {
    code: 'PACKAGE_DEPENDENCY_CYCLE',
    status: 409,
  });
});
