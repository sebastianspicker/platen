import assert from 'node:assert/strict';
import test from 'node:test';
import { runAdminAuditCommand } from '../scripts/cli/commands/admin-audit.mjs';
import { CLI_HELP, parseCliArguments } from '../scripts/cli/parser.mjs';

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

test('admin audit parser enforces exact list grammar and help', () => {
  assert.match(CLI_HELP, /admin\.audit-telemetry --action list --policy-root STATE_DIRECTORY \[--limit 1\.\.100\] \[--output STATE\.json\]/u);
  assert.throws(() => parseCliArguments([
    'professional-capability', '--capability-id', 'admin.audit-telemetry',
  ]), { code: 'CLI_DEDICATED_CAPABILITY_ENTRYPOINT' });
  assert.deepEqual(parseCliArguments([
    'admin.audit-telemetry', '--action', 'list', '--policy-root', 'state',
  ]), {
    command: 'admin.audit-telemetry', action: 'list', policyRoot: 'state', limit: 100, output: null,
  });
  assert.equal(Object.isFrozen(parseCliArguments([
    'admin.audit-telemetry', '--action', 'list', '--policy-root', 'state',
  ])), true);
  assert.deepEqual(parseCliArguments([
    'admin.audit-telemetry', '--action', 'list', '--policy-root', 'state',
    '--limit', '1', '--output', 'result.json',
  ]), {
    command: 'admin.audit-telemetry', action: 'list', policyRoot: 'state', limit: 1, output: 'result.json',
  });
  for (const argv of [
    [],
    ['--action', 'show', '--policy-root', 'state'],
    ['--action', 'list'],
    ['--action', 'list', '--policy-root', 'state', '--limit', '0'],
    ['--action', 'list', '--policy-root', 'state', '--limit', '101'],
    ['--action', 'list', '--policy-root', 'state', '--limit', '1.5'],
    ['--action', 'list', '--policy-root', 'state', '--limit', '1', '--limit', '2'],
    ['--action', 'list', '--policy-root', 'state', '--unknown', 'value'],
  ]) {
    assert.throws(() => parseCliArguments(['admin.audit-telemetry', ...argv]), { code: 'CLI_INVALID_OPTION' });
  }
  assert.throws(() => parseCliArguments([
    'admin.audit-telemetry', '--action', 'list', '--policy-root', 'state', 'extra',
  ]), { code: 'CLI_INVALID_ARGUMENTS' });
});

test('admin audit CLI calls list with only limit and emits frozen local output', async () => {
  const output = [];
  const events = [];
  const calls = [];
  const application = {
    adminAudit: {
      list: async (options) => { calls.push(options); return { entries: [] }; },
    },
  };
  await runAdminAuditCommand(application, {
    command: 'admin.audit-telemetry', action: 'list', policyRoot: 'state', limit: 7, output: 'result.json',
  }, null, null, runtimeFor(output, events));
  assert.deepEqual(calls, [{ limit: 7 }]);
  assert.deepEqual(output, [{ action: 'list', audit: { entries: [] }, localOnly: true }]);
  assert.equal(Object.isFrozen(output[0]), true);
  assert.deepEqual(events, ['cancelled', 'cancelled', 'output']);
  assert.equal('policyRoot' in output[0], false);
  assert.equal('output' in output[0], false);
});

test('admin audit CLI rejects unavailable and invalid actions', async () => {
  const runtime = runtimeFor([]);
  await assert.rejects(
    runAdminAuditCommand({}, { action: 'list', limit: 100 }, null, null, runtime),
    { code: 'ADMIN_AUDIT_UNAVAILABLE' },
  );
  await assert.rejects(
    runAdminAuditCommand({ adminAudit: { list: async () => ({}) } }, { action: 'other', limit: 100 }, null, null, runtime),
    { code: 'ADMIN_AUDIT_INVALID_ACTION' },
  );
});

test('admin audit CLI cancellation gates service calls and output', async () => {
  let serviceCalls = 0;
  let outputs = 0;
  const runtime = {
    cancelled: () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
    outputValue: async () => { outputs += 1; },
    fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  };
  await assert.rejects(
    runAdminAuditCommand({ adminAudit: {
      list: async () => { serviceCalls += 1; return {}; },
    } }, { action: 'list', limit: 100 }, null, {}, runtime),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(serviceCalls, 0);
  assert.equal(outputs, 0);
});
