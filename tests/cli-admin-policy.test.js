import assert from 'node:assert/strict';
import test from 'node:test';
import { runAdminPolicyCommand } from '../scripts/cli/commands/admin-policy.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';

const digest = 'a'.repeat(64);

function runtimeFor(output, events = []) {
  return {
    cancelled: () => events.push('cancelled'),
    outputValue: async (_command, _stdout, value) => {
      events.push('output');
      output.push(value);
    },
    fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  };
}

test('admin policy parser enforces exact show and set grammar', () => {
  assert.throws(() => parseCliArguments([
    'professional-capability', '--capability-id', 'admin.policy-configuration',
  ]), { code: 'CLI_DEDICATED_CAPABILITY_ENTRYPOINT' });
  assert.deepEqual(parseCliArguments([
    'admin.policy-configuration', '--action', 'show', '--policy-root', 'state',
  ]), {
    command: 'admin.policy-configuration', action: 'show', policyRoot: 'state', output: null,
  });
  assert.deepEqual(parseCliArguments([
    'admin.policy-configuration', '--action', 'set', '--policy-root', 'state',
    '--plugin-package-administration', 'enabled', '--expected-state-sha256', digest,
    '--output', 'result.json',
  ]), {
    command: 'admin.policy-configuration', action: 'set', policyRoot: 'state',
    pluginPackageAdministration: true, expectedStateSha256: digest, output: 'result.json',
  });
  for (const argv of [
    ['--action', 'show'],
    ['--action', 'show', '--policy-root', 'state', '--plugin-package-administration', 'enabled'],
    ['--action', 'set', '--policy-root', 'state', '--plugin-package-administration', 'enabled'],
    ['--action', 'set', '--policy-root', 'state', '--plugin-package-administration', 'enabled', '--plugin-package-administration', 'disabled', '--expected-state-sha256', digest],
    ['--action', 'set', '--policy-root', 'state', '--plugin-package-administration', 'maybe', '--expected-state-sha256', digest],
    ['--action', 'set', '--policy-root', 'state', '--plugin-package-administration', 'enabled', '--expected-state-sha256', digest.toUpperCase()],
  ]) {
    assert.throws(() => parseCliArguments(['admin.policy-configuration', ...argv]), { code: 'CLI_INVALID_OPTION' });
  }
  assert.throws(() => parseCliArguments([
    'admin.policy-configuration', '--action', 'set', '--policy-root', 'state',
    '--plugin-package-administration', 'enabled', '--expected-state-sha256', digest, 'extra',
  ]), { code: 'CLI_INVALID_ARGUMENTS' });
});

test('admin policy CLI runs show and set with local-only frozen outputs', async () => {
  const output = [];
  const events = [];
  const calls = [];
  const application = {
    adminAudit: {
      append: async (value) => { calls.push(['audit', value]); },
    },
    adminPolicy: {
      list: async () => { calls.push(['list']); return { enabled: false }; },
      setPluginPackageAdministration: async (value) => {
        calls.push(['set', value]);
        return { changed: true, state: { enabled: true, stateSha256: digest } };
      },
    },
  };
  const runtime = runtimeFor(output, events);
  await runAdminPolicyCommand(application, { action: 'show' }, null, null, runtime);
  await runAdminPolicyCommand(application, {
    action: 'set', pluginPackageAdministration: true, expectedStateSha256: digest,
  }, null, null, runtime);
  assert.deepEqual(calls, [
    ['list'],
    ['set', { enabled: true, expectedStateSha256: digest }],
    ['audit', {
      eventId: `policy.set:${digest}`, action: 'policy.set',
      subject: 'plugin-package-administration', outcome: 'succeeded',
    }],
  ]);
  assert.deepEqual(output, [
    { action: 'show', state: { enabled: false }, localOnly: true },
    { action: 'set', changed: true, state: { enabled: true, stateSha256: digest }, localOnly: true },
  ]);
  assert.equal(Object.isFrozen(output[0]), true);
  assert.equal(Object.isFrozen(output[1]), true);
  assert.deepEqual(events, ['cancelled', 'cancelled', 'output', 'cancelled', 'cancelled', 'output']);
});

test('admin policy CLI rejects unavailable and invalid actions', async () => {
  const output = [];
  const runtime = runtimeFor(output);
  await assert.rejects(
    runAdminPolicyCommand({}, { action: 'show' }, null, null, runtime),
    { code: 'ADMIN_POLICY_UNAVAILABLE' },
  );
  await assert.rejects(
    runAdminPolicyCommand({ adminPolicy: { list: async () => ({}), setPluginPackageAdministration: async () => ({}) } }, { action: 'other' }, null, null, runtime),
    { code: 'ADMIN_POLICY_INVALID_ACTION' },
  );
});

test('admin policy cancellation gates service calls', async () => {
  let serviceCalls = 0;
  let outputs = 0;
  const runtime = {
    cancelled: () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
    outputValue: async () => { outputs += 1; },
    fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  };
  await assert.rejects(
    runAdminPolicyCommand({ adminPolicy: {
      list: async () => { serviceCalls += 1; return {}; },
      setPluginPackageAdministration: async () => { serviceCalls += 1; return {}; },
    } }, { action: 'show' }, null, {}, runtime),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(serviceCalls, 0);
  assert.equal(outputs, 0);
});
