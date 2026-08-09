import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_INSPECT_PRESET,
} from '../scripts/host/automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS } from '../scripts/host/automation/automation-sequence-contract.mjs';
import { runCli } from '../scripts/platen-cli.mjs';
import {
  AUTOMATION_CONDITIONAL_CLI_GRANT,
  AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
  createAutomationConditionalCliAuthority,
} from '../scripts/cli/automation-conditional-authority.mjs';

const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });
const executionId = `cw_${'b'.repeat(32)}`;
const workflowId = 'workflow_1';
const inspectOperation = Object.freeze({ kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null });

function conditionalContext(action, overrides = {}) {
  return Object.freeze({
    principal: AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
    capability: 'automation.conditional',
    action,
    executionId,
    source,
    workflowId,
    operation: action === 'conditional.submit' ? inspectOperation : null,
    ...overrides,
  });
}

function apiContext(capability, action, overrides = {}) {
  return Object.freeze({
    principal: AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
    capability,
    action,
    source,
    operation: inspectOperation,
    jobId: null,
    outputId: null,
    ...overrides,
  });
}

function denied(promise) {
  return assert.rejects(promise, (error) => (
    error instanceof HostError
      && error.code === 'AUTOMATION_CONDITIONAL_CLI_AUTHORITY_DENIED'
      && error.status === 403
  ));
}

test('conditional CLI authority admits bound workflow actions and API queue contexts', async () => {
  const authority = createAutomationConditionalCliAuthority({ command: 'automation-run-conditional' });
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.execute'));
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.submit'));
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, apiContext('automation.submit', 'submit'));
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.cancel'));
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.release'));
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, apiContext('automation.cancel', 'cancel', {
    source: null, operation: null, jobId: 'job_1', outputId: null,
  }));
});

test('conditional CLI authority independently validates every allowlisted operation shape', async () => {
  const authority = createAutomationConditionalCliAuthority({ command: 'automation-run-conditional' });
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.execute'));
  for (const operation of [
    { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null },
    { kind: 'preset', id: AUTOMATION_INSPECT_PRESET, pages: null },
    { kind: 'sequence', id: AUTOMATION_SEQUENCE_IDS[0], pages: null },
    { kind: 'operation', id: AUTOMATION_FULL_PAGE_REDACTION_TYPE, pages: [1, 4] },
  ]) {
    await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.submit', { operation }));
  }
});

test('conditional CLI authority rejects drift, unsupported capabilities, and hostile values', async () => {
  const authority = createAutomationConditionalCliAuthority({ command: 'automation-run-conditional' });
  await authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.execute'));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.submit', {
    source: { ...source, id: 'other_source' },
  })));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.submit', {
    executionId: `cw_${'c'.repeat(32)}`,
  })));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.submit', {
    workflowId: 'bad workflow',
  })));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.execute', {
    operation: inspectOperation,
  })));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, conditionalContext('conditional.submit', {
    operation: { kind: 'operation', id: 'not-allowlisted', pages: null },
  })));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, {
    ...apiContext('automation.output', 'output'),
  }));
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT, apiContext('automation.cancel', 'cancel', {
    source: null, operation: null, jobId: 'job_1', outputId: 'unexpected',
  })));
  const proxy = new Proxy(AUTOMATION_CONDITIONAL_CLI_GRANT, { get() { throw new Error('proxy trap'); } });
  await denied(authority.authorize(proxy, conditionalContext('conditional.submit')));
  let accessed = false;
  const accessor = {};
  Object.defineProperty(accessor, 'id', { enumerable: true, get() { accessed = true; return source.id; } });
  Object.defineProperty(accessor, 'sha256', { enumerable: true, value: source.sha256 });
  await denied(authority.authorize(AUTOMATION_CONDITIONAL_CLI_GRANT,
    conditionalContext('conditional.submit', { source: accessor })));
  assert.equal(accessed, false);
});

test('conditional authority is absent for other commands and runCli injection is exclusive', async () => {
  assert.equal(createAutomationConditionalCliAuthority({ command: 'engines' }), null);
  const options = [];
  const application = {
    automation: {},
    close: async () => {},
    service: { async availability() { return []; } },
  };
  await assert.rejects(runCli([
    'automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'private',
  ], { createApplication: async (value) => { options.push(value); return application; } }));
  await assert.rejects(runCli([
    'automation-run-recipe', 'input.pdf', '--recipe', 'inspect-document-v1', '--automation-root', 'private',
  ], { createApplication: async (value) => { options.push(value); return application; } }));
  await runCli(['engines'], {
    createApplication: async (value) => { options.push(value); return application; },
  });
  assert.equal(typeof options[0].automationCapabilityAuthority?.authorize, 'function');
  assert.equal(typeof options[1].automationCapabilityAuthority?.authorize, 'function');
  assert.notEqual(options[0].automationCapabilityAuthority, options[1].automationCapabilityAuthority);
  assert.equal(Object.hasOwn(options[2], 'automationCapabilityAuthority'), false);
});
