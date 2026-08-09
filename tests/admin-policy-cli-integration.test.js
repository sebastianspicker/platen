import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';

function capture() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) { text += chunk.toString(); callback(); },
    }),
    value: () => JSON.parse(text),
  };
}

async function policyCli(policyRoot, args) {
  const output = capture();
  await runCli([
    'admin.policy-configuration', '--policy-root', policyRoot, ...args,
  ], { applicationRoot: process.cwd(), stdout: output.stream });
  return output.value();
}

test('real policy CLI persists one enforced control across clean application restarts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-admin-policy-cli-'));
  const policyRoot = join(root, 'policy');
  context.after(async () => {
    await chmod(policyRoot, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const initial = await policyCli(policyRoot, ['--action', 'show']);
  assert.equal(initial.action, 'show');
  assert.equal(initial.state.policy.pluginPackageAdministration, false);
  assert.equal(Object.hasOwn(initial, 'policyRoot'), false);

  const changed = await policyCli(policyRoot, [
    '--action', 'set',
    '--plugin-package-administration', 'enabled',
    '--expected-state-sha256', initial.state.stateSha256,
  ]);
  assert.equal(changed.action, 'set');
  assert.equal(changed.changed, true);
  assert.equal(changed.state.policy.pluginPackageAdministration, true);

  const restored = await policyCli(policyRoot, ['--action', 'show']);
  assert.equal(restored.state.stateSha256, changed.state.stateSha256);
  assert.equal(restored.state.policy.pluginPackageAdministration, true);
  assert.equal(restored.localOnly, true);
});
