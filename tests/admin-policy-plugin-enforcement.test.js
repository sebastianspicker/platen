import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalAdminPolicyAuthority } from '../scripts/host/admin-policy-authority.mjs';
import { PluginPackageStore } from '../scripts/host/plugin-package-store.mjs';
import {
  TrustedPublisherStore,
  pluginPackageSignedPayload,
  sha256,
} from '../scripts/host/plugin-package.mjs';

const keys = generateKeyPairSync('ed25519');
const pluginId = 'org.example.policy';

function signedPackage(version) {
  const content = Buffer.from('export default {};');
  const value = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 2,
      id: pluginId,
      name: 'Policy plugin',
      version,
      protocolVersion: 1,
      entry: 'index.mjs',
      capabilities: ['document.example'],
      permissions: [{ name: 'document.metadata', reason: 'Read metadata locally.' }],
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
      algorithm: 'ed25519', publisherId: 'org.example', keyId: 'policy', value: '',
    },
  };
  value.signature.value = sign(
    null,
    Buffer.from(pluginPackageSignedPayload(value)),
    keys.privateKey,
  ).toString('base64');
  return value;
}

function publishers() {
  const store = new TrustedPublisherStore();
  store.enroll({
    publisherId: 'org.example',
    keyId: 'policy',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    pluginIds: [pluginId],
  });
  return store;
}

test('durable local policy denies and enables real plugin package mutations across restart', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-admin-policy-plugin-'));
  const policyRoot = join(root, 'policy');
  const packageRoot = join(root, 'packages');
  context.after(async () => {
    await chmod(policyRoot, 0o700).catch(() => {});
    await chmod(packageRoot, 0o700).catch(() => {});
    await chmod(join(packageRoot, 'packages'), 0o700).catch(() => {});
    for (const digest of await readdir(join(packageRoot, 'packages')).catch(() => [])) {
      await chmod(join(packageRoot, 'packages', digest), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });

  const policy = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const packages = await new PluginPackageStore({
    root: packageRoot,
    trustedPublishers: publishers(),
    administrationPolicy: policy,
  }).initialize();
  await assert.rejects(packages.install(signedPackage('1.0.0')), {
    code: 'ADMIN_POLICY_DENIED', status: 403,
  });
  assert.deepEqual(packages.listPlugins(), []);

  const initial = await policy.list();
  const enabled = await policy.setPluginPackageAdministration({
    enabled: true,
    expectedStateSha256: initial.stateSha256,
  });
  assert.equal(enabled.changed, true);
  const replay = await policy.setPluginPackageAdministration({
    enabled: true,
    expectedStateSha256: initial.stateSha256,
  });
  assert.equal(replay.changed, false);
  await packages.install(signedPackage('1.0.0'));
  await packages.activate(pluginId, '1.0.0');

  const restoredPolicy = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const restoredPackages = await new PluginPackageStore({
    root: packageRoot,
    trustedPublishers: publishers(),
    administrationPolicy: restoredPolicy,
  }).initialize();
  assert.equal((await restoredPolicy.list()).policy.pluginPackageAdministration, true);
  await restoredPackages.install(signedPackage('2.0.0'));

  const current = await restoredPolicy.list();
  await restoredPolicy.setPluginPackageAdministration({
    enabled: false,
    expectedStateSha256: current.stateSha256,
  });
  await assert.rejects(restoredPackages.activate(pluginId, '2.0.0'), {
    code: 'ADMIN_POLICY_DENIED', status: 403,
  });
  assert.equal(restoredPackages.getPlugin(pluginId).activeVersion, '1.0.0');
});
