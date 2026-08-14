import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalAdminPolicyAuthority } from '../scripts/host/admin-policy-authority.mjs';
import { canonicalizePluginPackage, sha256 } from '../scripts/host/plugin-package-codec.mjs';

async function root() { return mkdtemp(join(tmpdir(), 'platen-admin-policy-test-')); }
const authorityModule = new URL('../scripts/host/admin-policy-authority.mjs', import.meta.url).href;

function payload(revision, enabled) {
  return {
    schemaVersion: 1,
    revision,
    policy: { pluginPackageAdministration: enabled },
  };
}

function state(revision, enabled) {
  const value = payload(revision, enabled);
  return { ...value, stateSha256: sha256(canonicalizePluginPackage(value)) };
}

async function authority() {
  const location = join(await root(), 'policy');
  return new LocalAdminPolicyAuthority({ root: location }).initialize();
}

function mutateInChild(policyRoot, enabled, expectedStateSha256) {
  const program = `
    import { LocalAdminPolicyAuthority } from ${JSON.stringify(authorityModule)};
    const policy = await new LocalAdminPolicyAuthority({ root: process.env.POLICY_ROOT }).initialize();
    try {
      console.log(JSON.stringify(await policy.setPluginPackageAdministration({
        enabled: process.env.POLICY_ENABLED === 'true', expectedStateSha256: process.env.POLICY_DIGEST,
      })));
    } catch (error) { console.log(JSON.stringify({ code: error.code, status: error.status })); }
  `;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
      env: {
        ...process.env,
        POLICY_ROOT: policyRoot,
        POLICY_ENABLED: String(enabled),
        POLICY_DIGEST: expectedStateSha256,
      },
    });
    let output = ''; let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.once('error', rejectChild);
    child.once('close', (status) => {
      if (status !== 0) rejectChild(new Error(`child mutation failed: ${errors}`));
      else resolveChild(JSON.parse(output));
    });
  });
}

test('admin policy starts disabled with an immutable, canonical, private state', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const policy = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const initial = await policy.list();
  assert.deepEqual(initial, state(0, false));
  assert.throws(() => { initial.policy.pluginPackageAdministration = true; }, TypeError);
  assert.throws(() => { initial.revision = 2; }, TypeError);
  assert.equal((await lstat(policyRoot)).mode & 0o777, 0o700);
  const statePath = join(policyRoot, 'admin-policy.json');
  assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
  assert.equal(await readFile(statePath, 'utf8'), canonicalizePluginPackage(initial));
});

test('admin policy persists exact canonical state and restores it on restart', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const first = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const changed = await first.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: (await first.list()).stateSha256,
  });
  assert.deepEqual(changed, { changed: true, state: state(1, true) });
  const restored = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  assert.deepEqual(await restored.list(), changed.state);
});

test('admin policy rejects unsafe, linked, corrupt, noncanonical, and oversized state', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const policy = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const statePath = join(policyRoot, 'admin-policy.json'); const original = await readFile(statePath, 'utf8');
  await writeFile(statePath, '{"policy":{"pluginPackageAdministration":false},"revision":0,"schemaVersion":1,"stateSha256":"0"}');
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_INVALID' });
  await writeFile(statePath, `${original.slice(0, -1)} `);
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_INVALID' });
  await writeFile(statePath, original);
  await chmod(statePath, 0o644);
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_UNSAFE' });
  await chmod(statePath, 0o600);
  await link(statePath, join(policyRoot, 'state-hardlink'));
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_UNSAFE' });
  await unlink(join(policyRoot, 'state-hardlink'));
  const linkRoot = join(base, 'link-root');
  await symlink(policyRoot, linkRoot);
  await assert.rejects(new LocalAdminPolicyAuthority({ root: linkRoot }).initialize(), { code: 'ADMIN_POLICY_ROOT_UNSAFE' });
  await writeFile(statePath, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_TOO_LARGE' });
  await writeFile(statePath, original, { mode: 0o600 });
  await policy.setPluginPackageAdministration({ enabled: true, expectedStateSha256: (await policy.list()).stateSha256 });
  const externalState = join(base, 'external-state.json');
  await writeFile(externalState, original, { mode: 0o600 });
  await unlink(statePath);
  await symlink(externalState, statePath);
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_UNSAFE' });
  await assert.rejects(policy.setPluginPackageAdministration({
    enabled: false, expectedStateSha256: (await policy.list()).stateSha256,
  }), { code: 'ADMIN_POLICY_STATE_UNSAFE' });
  assert.equal((await policy.list()).policy.pluginPackageAdministration, true);
  await unlink(statePath);
  await writeFile(statePath, canonicalizePluginPackage(state(1, true)), { mode: 0o600 });
  await policy.setPluginPackageAdministration({ enabled: false, expectedStateSha256: (await policy.list()).stateSha256 });
  await writeFile(statePath, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), { code: 'ADMIN_POLICY_STATE_TOO_LARGE' });
});

test('admin policy serializes compare-and-swap changes and accepts stale idempotent replay', async () => {
  const policy = await authority(); const initial = await policy.list();
  const [first, second] = await Promise.all([
    policy.setPluginPackageAdministration({ enabled: true, expectedStateSha256: initial.stateSha256 }),
    policy.setPluginPackageAdministration({ enabled: true, expectedStateSha256: initial.stateSha256 }),
  ]);
  assert.equal(first.changed, true); assert.equal(second.changed, false);
  assert.equal((await policy.list()).revision, 1);
  const replay = await policy.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: initial.stateSha256,
  });
  assert.equal(replay.changed, false);
  await assert.rejects(policy.setPluginPackageAdministration({
    enabled: false, expectedStateSha256: initial.stateSha256,
  }), { code: 'ADMIN_POLICY_CONFLICT', status: 409 });
  await assert.rejects(policy.setPluginPackageAdministration({ enabled: false, expectedStateSha256: 'bad' }), {
    code: 'ADMIN_POLICY_INVALID', status: 400,
  });
});

test('admin policy serializes compare-and-swap across separate processes', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const initial = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize().then((item) => item.list());
  const results = await Promise.all([
    mutateInChild(policyRoot, true, initial.stateSha256),
    mutateInChild(policyRoot, true, initial.stateSha256),
  ]);
  assert.equal(results.filter((result) => result.changed === true).length, 1);
  assert.equal(results.filter((result) => result.changed === false).length, 1);
  assert.deepEqual(await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize().then((item) => item.list()), state(1, true));
});

test('admin policy rejects Proxy updates before a proxy trap can run', async () => {
  const policy = await authority();
  const hostile = new Proxy({}, { get() { throw new Error('proxy trap ran'); } });
  await assert.rejects(policy.setPluginPackageAdministration(hostile), { code: 'ADMIN_POLICY_INVALID', status: 400 });
});

test('admin policy prevents revision overflow without changing persisted state', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const policy = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const maximum = state(Number.MAX_SAFE_INTEGER, false);
  await writeFile(join(policyRoot, 'admin-policy.json'), canonicalizePluginPackage(maximum), { mode: 0o600 });
  const restored = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  await assert.rejects(restored.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: maximum.stateSha256,
  }), { code: 'ADMIN_POLICY_REVISION_EXHAUSTED', status: 409 });
  assert.deepEqual(await restored.list(), maximum);
  assert.deepEqual(await policy.list(), state(0, false));
});

test('admin policy initialization sanitizes filesystem errors that name its root', async () => {
  const base = await root(); const obstacle = join(base, 'not-a-directory');
  await writeFile(obstacle, 'not a directory');
  const policyRoot = join(obstacle, 'policy');
  await assert.rejects(new LocalAdminPolicyAuthority({ root: policyRoot }).initialize(), (error) => {
    assert.equal(error.code, 'ADMIN_POLICY_INITIALIZATION_FAILED');
    assert.equal(error.message.includes(policyRoot), false);
    assert.equal(error.message.includes(base), false);
    return true;
  });
});

test('admin policy rolls back its in-memory state when persistence cannot proceed', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const policy = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const before = await policy.list();
  await chmod(policyRoot, 0o755);
  await assert.rejects(policy.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: before.stateSha256,
  }), { code: 'ADMIN_POLICY_ROOT_UNSAFE' });
  assert.deepEqual(await policy.list(), before);
  await chmod(policyRoot, 0o700);
  assert.deepEqual(await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize().then((item) => item.list()), before);
});

test('admin policy permits only enabled known plugin package mutation actions', async () => {
  const policy = await authority();
  await assert.rejects(policy.authorizePluginPackageMutation('install'), {
    code: 'ADMIN_POLICY_DENIED', status: 403,
  });
  await assert.rejects(policy.authorizePluginPackageMutation('delete'), {
    code: 'ADMIN_POLICY_ACTION_INVALID', status: 400,
  });
  await policy.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: (await policy.list()).stateSha256,
  });
  for (const action of ['install', 'activate', 'rollback']) {
    assert.equal(await policy.authorizePluginPackageMutation(action), true);
  }
});

test('admin policy authorization reloads a newer cross-authority disable under the lock', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const first = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  await first.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: (await first.list()).stateSha256,
  });
  const second = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  assert.equal((await second.list()).policy.pluginPackageAdministration, true);
  const third = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  await third.setPluginPackageAdministration({
    enabled: false, expectedStateSha256: (await third.list()).stateSha256,
  });
  await assert.rejects(second.authorizePluginPackageMutation('install'), {
    code: 'ADMIN_POLICY_DENIED', status: 403,
  });
  assert.equal((await second.list()).policy.pluginPackageAdministration, false);
});

test('admin policy serializes concurrent authorization and disable at the lock boundary', async () => {
  const base = await root(); const policyRoot = join(base, 'policy');
  const writer = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  await writer.setPluginPackageAdministration({
    enabled: true, expectedStateSha256: (await writer.list()).stateSha256,
  });
  const reader = await new LocalAdminPolicyAuthority({ root: policyRoot }).initialize();
  const expected = (await writer.list()).stateSha256;
  const [disable, authorization] = await Promise.allSettled([
    writer.setPluginPackageAdministration({ enabled: false, expectedStateSha256: expected }),
    reader.authorizePluginPackageMutation('install'),
  ]);
  assert.equal(disable.status, 'fulfilled');
  assert.ok(authorization.status === 'fulfilled'
    || authorization.reason?.code === 'ADMIN_POLICY_DENIED');
  await assert.rejects(reader.authorizePluginPackageMutation('install'), {
    code: 'ADMIN_POLICY_DENIED', status: 403,
  });
  assert.equal((await reader.list()).policy.pluginPackageAdministration, false);
});
