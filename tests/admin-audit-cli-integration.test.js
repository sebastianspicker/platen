import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import {
  canonicalizePluginPackage,
  pluginPackageSignedPayload,
  sha256,
} from '../scripts/host/plugin-package.mjs';

const pluginId = 'org.example.audited';

function capture() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) { text += chunk.toString(); callback(); },
    }),
    value: () => JSON.parse(text),
  };
}

async function cli(args) {
  const output = capture();
  await runCli(args, { applicationRoot: process.cwd(), stdout: output.stream });
  return output.value();
}

function signedPackage(keys) {
  const content = Buffer.from('export default {};');
  const value = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 2, id: pluginId, name: 'Audited plugin', version: '1.0.0',
      protocolVersion: 1, entry: 'index.mjs', capabilities: ['document.example'],
      permissions: [{ name: 'document.metadata', reason: 'Read metadata locally.' }],
      dependencies: [], activation: 'manual',
    },
    files: [{
      path: 'index.mjs', mediaType: 'text/javascript', size: content.length,
      sha256: sha256(content), content: content.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519', publisherId: 'org.example', keyId: 'audit', value: '',
    },
  };
  value.signature.value = sign(
    null,
    Buffer.from(pluginPackageSignedPayload(value)),
    keys.privateKey,
  ).toString('base64');
  return canonicalizePluginPackage(value);
}

test('dedicated CLIs durably audit real policy and package mutations across restarts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-admin-audit-cli-'));
  const policyRoot = join(root, 'policy');
  const pluginRoot = join(root, 'plugins');
  const trustRoot = join(root, 'trust');
  const publicKeyPath = join(root, 'publisher.pem');
  const packagePath = join(root, 'package.json');
  context.after(async () => {
    for (const directory of [policyRoot, pluginRoot, trustRoot]) {
      await chmod(directory, 0o700).catch(() => {});
    }
    await chmod(join(pluginRoot, 'packages'), 0o700).catch(() => {});
    for (const digest of await readdir(join(pluginRoot, 'packages')).catch(() => [])) {
      await chmod(join(pluginRoot, 'packages', digest), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });

  const keys = generateKeyPairSync('ed25519');
  await writeFile(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  await writeFile(packagePath, signedPackage(keys), { mode: 0o600 });
  await cli([
    'admin.plugin-allowlist', '--action', 'enroll', '--trust-root', trustRoot,
    '--publisher-id', 'org.example', '--key-id', 'audit',
    '--public-key', publicKeyPath, '--plugin-id', pluginId,
  ]);

  const initial = await cli([
    'admin.policy-configuration', '--action', 'show', '--policy-root', policyRoot,
  ]);
  await cli([
    'admin.policy-configuration', '--action', 'set', '--policy-root', policyRoot,
    '--plugin-package-administration', 'enabled',
    '--expected-state-sha256', initial.state.stateSha256,
  ]);
  await cli([
    'admin.plugin-package', '--action', 'install', '--plugin-root', pluginRoot,
    '--trust-root', trustRoot, '--policy-root', policyRoot, '--package', packagePath,
  ]);

  const audit = await cli([
    'admin.audit-telemetry', '--action', 'list', '--policy-root', policyRoot,
  ]);
  assert.deepEqual(audit.audit.records.map(({ action }) => action), [
    'policy.set', 'package.install',
  ]);
  assert.equal(audit.audit.count, 2);
  assert.equal(audit.audit.records[0].previousSha256, 'GENESIS');
  assert.equal(audit.audit.records[1].previousSha256, audit.audit.records[0].eventSha256);
  assert.equal(Object.hasOwn(audit, 'policyRoot'), false);

  const restored = await cli([
    'admin.audit-telemetry', '--action', 'list', '--policy-root', policyRoot,
    '--limit', '1',
  ]);
  assert.equal(restored.audit.count, 2);
  assert.equal(restored.audit.records.length, 1);
  assert.equal(restored.audit.records[0].action, 'package.install');
  assert.equal(restored.audit.stateSha256, audit.audit.stateSha256);
});
