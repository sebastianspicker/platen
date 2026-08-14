import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PluginPackageStore } from '../scripts/host/plugin-package-store.mjs';
import {
  TrustedPublisherStore, pluginPackageSignedPayload, sha256,
} from '../scripts/host/plugin-package.mjs';
import { PluginRuntimeAuthorityRegistry } from '../scripts/host/plugin-runtime-authority-registry.mjs';

const pluginId = 'org.example.transition';
const keys = generateKeyPairSync('ed25519');

function signedPackage(version) {
  const content = Buffer.from('export default {};');
  const value = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 2, id: pluginId, name: 'Transition test', version, protocolVersion: 1,
      entry: 'index.mjs', capabilities: ['document.example'],
      permissions: [{ name: 'document.metadata', reason: 'Read local document metadata.' }],
      dependencies: [], activation: 'manual',
    },
    files: [{
      path: 'index.mjs', mediaType: 'text/javascript', size: content.length,
      sha256: sha256(content), content: content.toString('base64'),
    }],
    signature: { algorithm: 'ed25519', publisherId: 'org.example', keyId: 'test', value: '' },
  };
  value.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(value)), keys.privateKey).toString('base64');
  return value;
}

function trust() {
  const store = new TrustedPublisherStore();
  store.enroll({
    publisherId: 'org.example', keyId: 'test',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    pluginIds: [pluginId],
  });
  return store;
}

test('package activation and rollback terminate the prior runtime before committing registry state', async () => {
  const calls = [];
  let packages; let authorities;
  packages = new PluginPackageStore({
    root: mkdtempSync(join(tmpdir(), 'pdf-plugin-transition-')),
    trustedPublishers: trust(),
    activationTransition: (transition) => authorities.transition(transition),
  });
  authorities = new PluginRuntimeAuthorityRegistry({
    resolveActivation: (id) => packages.getActivation(id),
  });
  await packages.initialize();
  const first = await packages.install(signedPackage('1.0.0'));
  await packages.install(signedPackage('2.0.0'));
  await packages.activate(pluginId, '1.0.0');
  await authorities.register({
    binding: {
      pluginId, version: '1.0.0', packageHash: first.digest,
      activationId: 'activation_abcdefghijklmnop', operationId: 'operation_abcdefghijklmnop',
      nonce: 'c'.repeat(64),
    },
    terminate: async () => {
      calls.push(`terminate:${packages.getPlugin(pluginId).activeVersion}`);
    },
  });
  await packages.activate(pluginId, '2.0.0');
  calls.push(`active:${packages.getPlugin(pluginId).activeVersion}`);
  assert.deepEqual(calls, ['terminate:1.0.0', 'active:2.0.0']);
  assert.equal(authorities.activeCount, 0);

  await packages.rollback(pluginId);
  assert.equal(packages.getPlugin(pluginId).activeVersion, '1.0.0');
});

test('an activation hook that omits commit cannot change active package state', async () => {
  const packages = await new PluginPackageStore({
    root: mkdtempSync(join(tmpdir(), 'pdf-plugin-transition-')),
    trustedPublishers: trust(),
    activationTransition: async () => {},
  }).initialize();
  await packages.install(signedPackage('1.0.0'));
  await assert.rejects(packages.activate(pluginId, '1.0.0'), {
    code: 'PACKAGE_TRANSITION_INCOMPLETE', status: 500,
  });
  assert.equal(packages.getPlugin(pluginId).activeVersion, null);
});

test('a hook error after durable commit cannot masquerade as activation failure', async () => {
  const packages = await new PluginPackageStore({
    root: mkdtempSync(join(tmpdir(), 'pdf-plugin-transition-')),
    trustedPublishers: trust(),
    activationTransition: async ({ commit }) => {
      await commit();
      throw new Error('forbidden post-commit work failed');
    },
  }).initialize();
  await packages.install(signedPackage('1.0.0'));
  const active = await packages.activate(pluginId, '1.0.0');
  assert.equal(active.version, '1.0.0');
  assert.equal(packages.getPlugin(pluginId).activeVersion, '1.0.0');
});

test('an unawaited commit is joined before activation returns', async () => {
  const packages = await new PluginPackageStore({
    root: mkdtempSync(join(tmpdir(), 'pdf-plugin-transition-')),
    trustedPublishers: trust(),
    activationTransition: ({ commit }) => { void commit(); },
  }).initialize();
  await packages.install(signedPackage('1.0.0'));
  const active = await packages.activate(pluginId, '1.0.0');
  assert.equal(active.version, '1.0.0');
  assert.equal(packages.getPlugin(pluginId).activeVersion, '1.0.0');
});
