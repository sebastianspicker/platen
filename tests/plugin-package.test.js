import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import {
  PACKAGE_LIMITS, TrustedPublisherStore, canonicalizePluginPackage, pluginPackageSignedPayload, sha256, verifyPluginPackage,
} from '../scripts/host/plugin-package.mjs';
import { PluginPackageStore, resolvePinnedDependencyDag } from '../scripts/host/plugin-package-store.mjs';

const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' });

function trust(pluginIds = ['org.example.plugin']) {
  const publishers = new TrustedPublisherStore();
  publishers.enroll({ publisherId: 'org.example', keyId: 'test-key', publicKey, pluginIds });
  return publishers;
}

function packageRoot() { return mkdtempSync(join(tmpdir(), 'pdf-plugin-package-test-')); }

function signedPackage({ id = 'org.example.plugin', version = '1.0.0', files = [{ path: 'index.mjs', mediaType: 'text/javascript', content: 'export default {};' }], permissions = [{ name: 'document.metadata', reason: 'Read document metadata locally.' }], dependencies = [] } = {}) {
  const inventory = files.map((file) => {
    const content = Buffer.from(file.content);
    return { path: file.path, mediaType: file.mediaType, size: content.length, sha256: sha256(content), content: content.toString('base64') };
  });
  const result = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 2, id, name: 'Example plugin', version, protocolVersion: 1,
      entry: 'index.mjs', capabilities: ['document.example'], permissions, dependencies, activation: 'manual',
    },
    files: inventory,
    signature: { algorithm: 'ed25519', publisherId: 'org.example', keyId: 'test-key', value: '' },
  };
  result.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(result)), keyPair.privateKey).toString('base64');
  return result;
}

function resign(pluginPackage) {
  pluginPackage.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(pluginPackage)), keyPair.privateKey).toString('base64');
  return pluginPackage;
}

function signedExecutablePackage({ source = 'globalThis.pluginReady = true;', dependencies = [] } = {}) {
  const pluginPackage = signedPackage({ files: [{ path: 'index.js', mediaType: 'text/javascript', content: source }], dependencies });
  pluginPackage.manifest = {
    ...pluginPackage.manifest,
    manifestVersion: 3,
    entry: 'index.js',
    runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 },
  };
  return resign(pluginPackage);
}

test('signed package verification is deterministic and accepts only externally enrolled Ed25519 publishers', () => {
  const pluginPackage = signedPackage();
  const first = verifyPluginPackage(pluginPackage, trust());
  const reordered = JSON.parse(canonicalizePluginPackage({ files: pluginPackage.files, manifest: pluginPackage.manifest, packageVersion: 1, signature: pluginPackage.signature }));
  const second = verifyPluginPackage(reordered, trust());
  assert.equal(first.digest, second.digest);
  assert.equal(first.files[0].path, 'index.mjs');
  assert.throws(() => verifyPluginPackage(pluginPackage, new TrustedPublisherStore()), { code: 'PUBLISHER_UNTRUSTED', status: 403 });
});

test('package verification rejects a look-alike trusted publisher store', () => {
  assert.throws(() => verifyPluginPackage(signedPackage(), { get: () => null }), {
    code: 'TRUST_STORE_REQUIRED', status: 500,
  });
});

test('manifest v2 packages remain signed and installable metadata but cannot describe an executable runtime', () => {
  const verified = verifyPluginPackage(signedPackage(), trust());
  assert.equal(verified.manifest.manifestVersion, 2);
  assert.equal(verified.executableRuntime, null);
  assert.equal(Object.hasOwn(verified.manifest, 'runtime'), false);
});

test('plugin package schemas declare disjoint v2 and v3 runtime contracts', () => {
  const packageSchema = JSON.parse(readFileSync('contracts/plugin-package.schema.json', 'utf8'));
  const runtimeSchema = JSON.parse(readFileSync('contracts/runtime-plugin-manifest.schema.json', 'utf8'));
  for (const schema of [packageSchema.$defs.manifest, runtimeSchema]) assert.equal(schema.oneOf.length, 2);
  assert.equal(packageSchema.$defs.manifestV2.properties.manifestVersion.const, 2);
  assert.equal(packageSchema.$defs.manifestV3.properties.manifestVersion.const, 3);
  assert.equal(packageSchema.$defs.manifestV3.properties.entry.allOf[1].pattern, '[.]js$');
  assert.equal(packageSchema.$defs.manifestV3.properties.dependencies.maxItems, 0);
  assert.deepEqual(packageSchema.$defs.runtime.properties, { kind: { const: 'javascriptcore-classic-script' }, apiVersion: { const: 1 } });
});

test('manifest v3 binds an exact JavaScriptCore classic runtime and its signed source identity', () => {
  const pluginPackage = signedExecutablePackage({ source: "globalThis.pluginReady = 'import export'; // import\n" });
  const verified = verifyPluginPackage(pluginPackage, trust());
  assert.deepEqual(verified.executableRuntime, {
    kind: 'javascriptcore-classic-script', apiVersion: 1, entry: 'index.js', sha256: pluginPackage.files[0].sha256,
  });
  assert.equal(Object.isFrozen(verified.executableRuntime), true);
  assert.equal(Object.hasOwn(verified.executableRuntime, 'source'), false);
  const changedRuntime = structuredClone(pluginPackage);
  changedRuntime.manifest.runtime.apiVersion = 2;
  assert.throws(() => verifyPluginPackage(changedRuntime, trust()), { code: 'PACKAGE_RUNTIME_INVALID' });
  const changedSource = structuredClone(pluginPackage);
  changedSource.files[0].content = Buffer.from('globalThis.pluginReady = false;').toString('base64');
  changedSource.files[0].size = Buffer.byteLength('globalThis.pluginReady = false;');
  changedSource.files[0].sha256 = sha256('globalThis.pluginReady = false;');
  assert.throws(() => verifyPluginPackage(changedSource, trust()), { code: 'PACKAGE_SIGNATURE_INVALID' });
});

test('manifest v3 rejects legacy module entries, runtime drift, dependencies, and module syntax before trust authority', () => {
  const malformed = [
    (() => { const value = signedExecutablePackage(); value.manifest.entry = 'index.mjs'; return value; })(),
    (() => { const value = signedExecutablePackage(); delete value.manifest.runtime; return value; })(),
    (() => { const value = signedExecutablePackage(); value.manifest.runtime.extra = true; return value; })(),
    signedExecutablePackage({ dependencies: [{ id: 'org.example.child', version: '1.0.0', digest: 'a'.repeat(64) }] }),
  ];
  for (const value of malformed) assert.throws(() => verifyPluginPackage(resign(value), trust()), (error) => ['PACKAGE_INVALID', 'PACKAGE_MANIFEST_INVALID', 'PACKAGE_RUNTIME_INVALID', 'PACKAGE_RUNTIME_DEPENDENCIES_DISABLED'].includes(error.code));
  for (const source of ["import './child.js';", 'export const pluginReady = true;']) {
    assert.throws(() => verifyPluginPackage(signedExecutablePackage({ source }), trust()), { code: 'PACKAGE_RUNTIME_MODULE_SYNTAX' });
  }
  const mjsInventory = signedExecutablePackage();
  mjsInventory.files.push({ path: 'unused.mjs', mediaType: 'text/javascript', size: 1, sha256: sha256('x'), content: Buffer.from('x').toString('base64') });
  assert.throws(() => verifyPluginPackage(resign(mjsInventory), trust()), { code: 'PACKAGE_RUNTIME_INVALID' });
});

test('serialized packages require canonical UTF-8 JSON and verified bytes cannot be mutated through the result', () => {
  const pluginPackage = signedPackage();
  const canonical = canonicalizePluginPackage(pluginPackage);
  const verified = verifyPluginPackage(Buffer.from(canonical), trust());
  const first = verified.getContent('index.mjs');
  first.fill(0);
  assert.equal(verified.getContent('index.mjs').toString(), 'export default {};');
  assert.equal(Object.isFrozen(verified.manifest.permissions[0]), true);

  const duplicateKey = canonical.replace('{"files":', '{"packageVersion":1,"files":');
  assert.throws(() => verifyPluginPackage(duplicateKey, trust()), { code: 'PACKAGE_NONCANONICAL' });
  assert.throws(() => verifyPluginPackage(Buffer.from([0xc3, 0x28]), trust()), { code: 'PACKAGE_INVALID_UTF8' });
});

test('publisher trust is plugin-scoped and serializes public trust material without private keys', () => {
  const publishers = trust();
  assert.throws(() => verifyPluginPackage(signedPackage({ id: 'org.example.other' }), publishers), { code: 'PUBLISHER_SCOPE_DENIED', status: 403 });
  const state = publishers.exportState();
  assert.equal(state.publishers[0].pluginIds[0], 'org.example.plugin');
  assert.equal(JSON.stringify(state).includes('PRIVATE KEY'), false);
  const restored = new TrustedPublisherStore();
  restored.importState(state);
  assert.equal(verifyPluginPackage(signedPackage(), restored).manifest.manifestVersion, 2);
  const projection = restored.get('org.example', 'test-key');
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.pluginIds), true);
  assert.throws(() => projection.pluginIds.push('org.example.other'), TypeError);
  const damaged = structuredClone(state);
  damaged.publishers[0].fingerprint = '0'.repeat(64);
  assert.throws(() => restored.importState(damaged), { code: 'TRUST_STATE_INVALID' });
});

test('publisher identity metadata is signed and a public-key fingerprint cannot be relabeled', () => {
  const original = signedPackage();
  const relabeled = structuredClone(original);
  relabeled.signature.publisherId = 'org.relabel';
  assert.notEqual(pluginPackageSignedPayload(original), pluginPackageSignedPayload(relabeled));
  const publishers = trust();
  assert.throws(() => publishers.enroll({ publisherId: 'org.relabel', keyId: 'other-key', publicKey, pluginIds: ['org.relabel.plugin'] }), { code: 'TRUST_KEY_AMBIGUOUS', status: 409 });
});

test('package verification rejects tampering and revoked publisher keys', () => {
  const pluginPackage = signedPackage();
  pluginPackage.files[0].content = Buffer.from('tampered').toString('base64');
  assert.throws(() => verifyPluginPackage(pluginPackage, trust()), { code: 'PACKAGE_FILE_INTEGRITY_FAILED' });

  const publishers = trust();
  publishers.revoke({ publisherId: 'org.example', keyId: 'test-key' });
  assert.throws(() => verifyPluginPackage(signedPackage(), publishers), { code: 'PUBLISHER_REVOKED', status: 403 });
});

test('package verification rejects traversal, encoded ambiguity, collisions, and local-policy violations', () => {
  for (const path of ['../index.mjs', 'plugins/%2e%2e/index.mjs', 'plugins\\index.mjs']) {
    const pluginPackage = signedPackage({ files: [{ path, mediaType: 'text/javascript', content: 'x' }] });
    pluginPackage.manifest.entry = path;
    pluginPackage.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(pluginPackage)), keyPair.privateKey).toString('base64');
    assert.throws(() => verifyPluginPackage(pluginPackage, trust()), { code: 'PACKAGE_PATH_INVALID' });
  }
  const collision = signedPackage({ files: [{ path: 'index.mjs', mediaType: 'text/javascript', content: 'x' }, { path: 'INDEX.mjs', mediaType: 'text/javascript', content: 'y' }] });
  assert.throws(() => verifyPluginPackage(collision, trust()), { code: 'PACKAGE_PATH_COLLISION' });
  const remote = signedPackage({ permissions: [{ name: 'network.fetch', reason: 'This package asks to make remote requests.' }] });
  assert.throws(() => verifyPluginPackage(remote, trust()), { code: 'PACKAGE_PERMISSION_FORBIDDEN' });
  const nonJavaScriptEntry = signedPackage({ files: [{ path: 'index.mjs', mediaType: 'application/octet-stream', content: 'export default {};' }] });
  assert.throws(() => verifyPluginPackage(nonJavaScriptEntry, trust()), { code: 'PACKAGE_MANIFEST_INVALID' });
  const duplicateDependency = signedPackage({ dependencies: [{ id: 'org.example.dependency', version: '1.0.0', digest: 'a'.repeat(64) }, { id: 'org.example.dependency', version: '1.0.0', digest: 'b'.repeat(64) }] });
  assert.throws(() => verifyPluginPackage(duplicateDependency, trust()), { code: 'PACKAGE_MANIFEST_INVALID' });
});

test('package store rehashes activation content, prevents downgrade activation, and supports controlled rollback', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  const v1 = await store.install(signedPackage({ version: '1.0.0' }));
  const v2 = await store.install(signedPackage({ version: '2.0.0' }));
  await store.activate('org.example.plugin', '1.0.0');
  const current = await store.activate('org.example.plugin', '2.0.0');
  assert.equal(current.version, '2.0.0');
  await assert.rejects(store.activate('org.example.plugin', '1.0.0', { allowDowngrade: true }), { code: 'PACKAGE_DOWNGRADE_REJECTED', status: 409 });
  const rolledBack = await store.rollback('org.example.plugin');
  assert.equal(rolledBack.version, '1.0.0');

  const packageFile = join(root, 'packages', v1.digest, 'index.mjs');
  chmodSync(packageFile, 0o600);
  writeFileSync(packageFile, 'tampered');
  await assert.rejects(store.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });
  assert.notEqual(v1.digest, v2.digest);
});

test('store rejects same plugin version with a different signed digest and exposes metadata without package paths or content', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  await store.install(signedPackage());
  await assert.rejects(store.install(signedPackage({ files: [{ path: 'index.mjs', mediaType: 'text/javascript', content: 'export const replacement = true;' }] })), { code: 'PACKAGE_VERSION_CONFLICT', status: 409 });
  assert.deepEqual(store.listPlugins(), [{ id: 'org.example.plugin', activeVersion: null, previousVersion: null, versions: [{ version: '1.0.0', digest: store.getPlugin('org.example.plugin').versions[0].digest }] }]);
  assert.equal(Object.hasOwn(store.getPlugin('org.example.plugin'), 'path'), false);
  assert.equal(Object.hasOwn(store.getPlugin('org.example.plugin'), 'content'), false);
});

test('store rejects structurally valid but signed-package-mismatched registry recovery', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  const installed = await store.install(signedPackage());
  writeFileSync(join(root, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: { 'org.example.plugin': { versions: { '1.0.0': { digest: installed.digest, installedAt: new Date().toISOString() } }, active: { version: '1.0.0', digest: installed.digest }, previous: null } },
  }));
  const reloaded = new PluginPackageStore({ root, trustedPublishers: trust() });
  await reloaded.initialize();
  const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
  registry.plugins['org.example.plugin'].versions = { '2.0.0': registry.plugins['org.example.plugin'].versions['1.0.0'] };
  registry.plugins['org.example.plugin'].active.version = '2.0.0';
  writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
  await assert.rejects(new PluginPackageStore({ root, trustedPublishers: trust() }).initialize(), { code: 'PACKAGE_REGISTRY_MISMATCH', status: 500 });
});

test('activation rejects unsigned files and symlinks in the installed package tree', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  const installed = await store.install(signedPackage());
  await store.activate('org.example.plugin', '1.0.0');
  const packageDirectory = join(root, 'packages', installed.digest);
  chmodSync(packageDirectory, 0o700);
  writeFileSync(join(packageDirectory, 'unsigned.txt'), 'not in signed inventory');
  await assert.rejects(store.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });

  const cleanRoot = packageRoot();
  const cleanStore = await new PluginPackageStore({ root: cleanRoot, trustedPublishers: trust() }).initialize();
  const clean = await cleanStore.install(signedPackage());
  await cleanStore.activate('org.example.plugin', '1.0.0');
  const cleanDirectory = join(cleanRoot, 'packages', clean.digest);
  chmodSync(cleanDirectory, 0o700);
  symlinkSync('index.mjs', join(cleanDirectory, 'unsigned-link.mjs'));
  await assert.rejects(cleanStore.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });
});

test('activation rejects swapped, hard-linked, malformed, and oversized package metadata', async () => {
  const symlinkRoot = packageRoot();
  const symlinkStore = await new PluginPackageStore({ root: symlinkRoot, trustedPublishers: trust() }).initialize();
  const symlinked = await symlinkStore.install(signedPackage());
  await symlinkStore.activate('org.example.plugin', '1.0.0');
  const symlinkDirectory = join(symlinkRoot, 'packages', symlinked.digest);
  const packageJson = join(symlinkDirectory, 'package.json');
  const replacement = join(symlinkRoot, 'replacement-package.json');
  chmodSync(symlinkDirectory, 0o700);
  writeFileSync(replacement, readFileSync(packageJson));
  unlinkSync(packageJson);
  symlinkSync(replacement, packageJson);
  await assert.rejects(symlinkStore.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });

  const hardLinkRoot = packageRoot();
  const hardLinkStore = await new PluginPackageStore({ root: hardLinkRoot, trustedPublishers: trust() }).initialize();
  const hardLinked = await hardLinkStore.install(signedPackage());
  await hardLinkStore.activate('org.example.plugin', '1.0.0');
  const hardLinkPackageJson = join(hardLinkRoot, 'packages', hardLinked.digest, 'package.json');
  linkSync(hardLinkPackageJson, join(hardLinkRoot, 'external-package.json'));
  await assert.rejects(hardLinkStore.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });

  const utf8Root = packageRoot();
  const utf8Store = await new PluginPackageStore({ root: utf8Root, trustedPublishers: trust() }).initialize();
  const utf8Installed = await utf8Store.install(signedPackage());
  await utf8Store.activate('org.example.plugin', '1.0.0');
  const utf8Directory = join(utf8Root, 'packages', utf8Installed.digest);
  chmodSync(utf8Directory, 0o700);
  const utf8PackageJson = join(utf8Directory, 'package.json');
  chmodSync(utf8PackageJson, 0o600);
  writeFileSync(utf8PackageJson, Buffer.from([0xc3, 0x28]));
  await assert.rejects(utf8Store.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });

  const boundedRoot = packageRoot();
  const boundedStore = await new PluginPackageStore({ root: boundedRoot, trustedPublishers: trust() }).initialize();
  const bounded = await boundedStore.install(signedPackage());
  await boundedStore.activate('org.example.plugin', '1.0.0');
  const boundedDirectory = join(boundedRoot, 'packages', bounded.digest);
  const boundedPackageJson = join(boundedDirectory, 'package.json');
  const metadata = JSON.parse(readFileSync(boundedPackageJson, 'utf8'));
  chmodSync(boundedDirectory, 0o700);
  chmodSync(boundedPackageJson, 0o600);
  metadata.files[0].size = PACKAGE_LIMITS.maxFileBytes + 1;
  writeFileSync(boundedPackageJson, JSON.stringify(metadata));
  await assert.rejects(boundedStore.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });
});

test('activation accepts nested signed files but rejects hard-linked package content', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  const nested = await store.install(signedPackage({ files: [
    { path: 'index.mjs', mediaType: 'text/javascript', content: "import './lib/helper.mjs';" },
    { path: 'lib/helper.mjs', mediaType: 'text/javascript', content: 'export const helper = true;' },
  ] }));
  assert.equal((await store.activate('org.example.plugin', '1.0.0')).version, '1.0.0');
  const directory = join(root, 'packages', nested.digest);
  chmodSync(directory, 0o700);
  linkSync(join(directory, 'index.mjs'), join(root, 'external-hard-link.mjs'));
  await assert.rejects(store.getActivation('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });
});

test('activation resolves a signed pinned dependency DAG and returns dependency identities', async () => {
  const scopes = ['org.example.root', 'org.example.child']; const publishers = trust(scopes);
  const child = signedPackage({ id: 'org.example.child' });
  const childDigest = verifyPluginPackage(child, publishers).digest;
  const rootPackage = signedPackage({ id: 'org.example.root', dependencies: [{ id: 'org.example.child', version: '1.0.0', digest: childDigest }] });
  const store = await new PluginPackageStore({ root: packageRoot(), trustedPublishers: publishers }).initialize();
  await store.install(child); await store.install(rootPackage);
  const activation = await store.activate('org.example.root', '1.0.0');
  assert.deepEqual(activation.dependencies, [{ id: 'org.example.child', version: '1.0.0', digest: childDigest }]);
});

test('launch descriptor is host-only, immutable, and has freshly verified package coordinates', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  const installed = await store.install(signedPackage());
  await store.activate('org.example.plugin', '1.0.0');
  const descriptor = await store.getLaunchDescriptor('org.example.plugin');
  assert.deepEqual(Object.keys(descriptor).sort(), ['dependencies', 'digest', 'entryPath', 'executableRuntime', 'id', 'inventory', 'manifest', 'packageHash', 'packageRoot', 'publisher', 'version']);
  assert.equal(descriptor.digest, installed.digest);
  assert.equal(descriptor.packageHash, installed.digest);
  assert.equal(descriptor.entryPath, join(descriptor.packageRoot, descriptor.manifest.entry));
  assert.equal(isAbsolute(descriptor.packageRoot), true);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.inventory), true);
  assert.equal(descriptor.executableRuntime, null);
  assert.equal(Object.hasOwn(descriptor, 'content'), false);
  assert.equal(Object.hasOwn(descriptor, 'path'), false);

  const packageJson = join(descriptor.packageRoot, 'package.json');
  chmodSync(descriptor.packageRoot, 0o700);
  chmodSync(packageJson, 0o600);
  const metadata = JSON.parse(readFileSync(packageJson, 'utf8'));
  metadata.untrusted = true;
  writeFileSync(packageJson, JSON.stringify(metadata));
  await assert.rejects(store.getLaunchDescriptor('org.example.plugin'), { code: 'PACKAGE_INTEGRITY_FAILED', status: 500 });
});

test('package store releases only freshly reverified manifest-v3 entry bytes for native launch', async () => {
  const root = packageRoot();
  const store = await new PluginPackageStore({ root, trustedPublishers: trust() }).initialize();
  await store.install(signedPackage());
  await store.activate('org.example.plugin', '1.0.0');
  await assert.rejects(store.getExecutableLaunch('org.example.plugin'), {
    code: 'PACKAGE_RUNTIME_NOT_EXECUTABLE', status: 409,
  });

  const executableRoot = packageRoot();
  const executableStore = await new PluginPackageStore({ root: executableRoot, trustedPublishers: trust() }).initialize();
  const pluginPackage = signedExecutablePackage({ source: 'registerPlugin({ invoke(input) { return input; } });' });
  await executableStore.install(pluginPackage);
  await executableStore.activate('org.example.plugin', '1.0.0');
  const launch = await executableStore.getExecutableLaunch('org.example.plugin');
  assert.deepEqual(Object.keys(launch), ['descriptor', 'source']);
  assert.equal(launch.source.toString(), 'registerPlugin({ invoke(input) { return input; } });');
  assert.equal(sha256(launch.source), launch.descriptor.executableRuntime.sha256);
  assert.equal(Object.hasOwn(launch.descriptor, 'content'), false);
  launch.source.fill(0);
  assert.equal((await executableStore.getExecutableLaunch('org.example.plugin')).source.toString(), 'registerPlugin({ invoke(input) { return input; } });');
});

test('dependency resolver rejects missing, wrong-digest, and cyclic dependency graphs', async () => {
  const root = { id: 'org.example.root', version: '1.0.0', digest: 'a'.repeat(64) };
  await assert.rejects(resolvePinnedDependencyDag(root, async () => null), { code: 'PACKAGE_DEPENDENCY_MISSING', status: 424 });
  await assert.rejects(resolvePinnedDependencyDag(root, async () => ({ digest: 'b'.repeat(64), manifest: { id: root.id, version: root.version, dependencies: [] } })), { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 });
  const child = { id: 'org.example.child', version: '1.0.0', digest: 'b'.repeat(64) };
  const graph = new Map([
    [`${root.id}:${root.version}`, { digest: root.digest, manifest: { id: root.id, version: root.version, dependencies: [child] } }],
    [`${child.id}:${child.version}`, { digest: child.digest, manifest: { id: child.id, version: child.version, dependencies: [root] } }],
  ]);
  await assert.rejects(resolvePinnedDependencyDag(root, async (request) => graph.get(`${request.id}:${request.version}`)), { code: 'PACKAGE_DEPENDENCY_CYCLE', status: 409 });
});
