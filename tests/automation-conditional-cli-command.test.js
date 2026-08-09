import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runAutomationCommand } from '../scripts/cli/commands/automation.mjs';
import {
  AUTOMATION_CONDITIONAL_CLI_GRANT,
  AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
} from '../scripts/cli/automation-conditional-authority.mjs';

const workflow = Object.freeze({
  workflowId: 'workflow-1',
  steps: Object.freeze([Object.freeze({
    stepId: 'step-1',
    condition: Object.freeze({ field: 'document.pageCount', operator: 'gte', value: 1 }),
    trueBranch: Object.freeze({ operation: Object.freeze({ kind: 'operation', id: 'automation_inspect_v1', pages: null }), repeat: 1 }),
    falseBranch: Object.freeze({ operation: null, repeat: 1 }),
  })]),
});

const command = (overrides = {}) => ({
  command: 'automation-run-conditional', input: 'input.pdf', workflow: 'workflow.json',
  automationRoot: 'private', idempotencyKey: null, output: null, ...overrides,
});

function fixture({ source = { id: 'source_1', sha256: 'a'.repeat(64), size: 12 }, execute = null,
  release = null, cancel = null, output = null, commit = null, workflowBytes = null } = {}) {
  const events = [];
  const document = { id: 'document_1', sha256: 'a'.repeat(64), size: 12 };
  const bytes = workflowBytes ?? Buffer.from(JSON.stringify(workflow));
  const application = {
    store: { async deleteDocument(id) { events.push(['delete', id]); } },
    automation: {
      sources: {
        async stageDocument(value) { events.push(['stage', value]); return source; },
        async commit(value) { events.push(['commit', value.id]); if (commit) return commit(value, events); },
        async discardCreated(value) { events.push(['discard', value.id]); return true; },
      },
      conditionalWorkflows: {
        async execute(value, options) {
          events.push(['execute', value, options]);
          return execute ? execute(value, options, events) : { executionId: 'cw_1234567890abcdef1234567890abcdef', queuedCount: 1 };
        },
        async cancel(value) { events.push(['cancel', value]); if (cancel) return cancel(value, events); },
        async release(value) {
          events.push(['release', value]);
          return release ? release(value, events) : { schemaVersion: 1, executionId: value.executionId, released: true, localOnly: true };
        },
      },
    },
  };
  const runtime = {
    async readLocalInputBytes(path, options) { events.push(['read-workflow', path, options]); return { bytes }; },
    async uploadPdf(_application, path) { events.push(['upload', path]); return document; },
    cancelled() {},
    async outputValue(_command, _stdout, value) { events.push(['output', value]); if (output) throw output; },
  };
  return { application, runtime, events, document, bytes };
}

test('conditional command reads bounded JSON and zeroes the selected bytes', async () => {
  const state = fixture();
  await runAutomationCommand(state.application, command(), {}, state.runtime);
  const read = state.events.find((event) => event[0] === 'read-workflow');
  assert.equal(read[1], 'workflow.json');
  assert.deepEqual(read[2], { minimumBytes: 2, maximumBytes: 65_536, extension: '.json', signal: undefined });
  assert.equal(state.bytes.every((byte) => byte === 0), true);
});

test('conditional request and default key are exact and deterministic', async () => {
  const first = fixture();
  const second = fixture();
  await runAutomationCommand(first.application, command(), {}, first.runtime);
  await runAutomationCommand(second.application, command(), {}, second.runtime);
  const requestA = first.events.find((event) => event[0] === 'execute')[1];
  const requestB = second.events.find((event) => event[0] === 'execute')[1];
  const key = `conditional-${createHash('sha256').update(JSON.stringify(['a'.repeat(64), workflow]), 'utf8').digest('hex')}`;
  assert.deepEqual(requestA, requestB);
  assert.deepEqual(requestA, {
    principal: AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
    grant: AUTOMATION_CONDITIONAL_CLI_GRANT,
    source: { id: 'source_1', sha256: 'a'.repeat(64) },
    workflow,
    idempotencyKey: key,
  });
  assert.ok(key.length <= 96);
  assert.ok(first.events.findIndex((event) => event[0] === 'commit') < first.events.findIndex((event) => event[0] === 'execute'));
  assert.ok(first.events.findIndex((event) => event[0] === 'execute') < first.events.findIndex((event) => event[0] === 'release'));
  assert.equal(first.events.find((event) => event[0] === 'output')[1].kind, 'automation-declarative-conditional-run');
});

test('default key canonicalizes semantically identical workflow object key order', async () => {
  const reordered = {
    steps: [{
      falseBranch: { repeat: 1, operation: null },
      trueBranch: { repeat: 1, operation: { pages: null, id: 'automation_inspect_v1', kind: 'operation' } },
      condition: { value: 1, operator: 'gte', field: 'document.pageCount' },
      stepId: 'step-1',
    }],
    workflowId: 'workflow-1',
  };
  const first = fixture();
  const second = fixture({ workflowBytes: Buffer.from(JSON.stringify(reordered)) });
  await runAutomationCommand(first.application, command(), {}, first.runtime);
  await runAutomationCommand(second.application, command(), {}, second.runtime);
  const requestA = first.events.find((event) => event[0] === 'execute')[1];
  const requestB = second.events.find((event) => event[0] === 'execute')[1];
  assert.equal(requestA.idempotencyKey, requestB.idempotencyKey);
  assert.deepEqual(requestA.workflow, requestB.workflow);
});

test('explicit key is preserved and release is bound to exact principal, grant, and execution', async () => {
  const state = fixture();
  await runAutomationCommand(state.application, command({ idempotencyKey: 'user-key-1' }), {}, state.runtime);
  const request = state.events.find((event) => event[0] === 'execute')[1];
  const release = state.events.find((event) => event[0] === 'release')[1];
  assert.equal(request.idempotencyKey, 'user-key-1');
  assert.deepEqual(release, {
    principal: AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
    grant: AUTOMATION_CONDITIONAL_CLI_GRANT,
    executionId: 'cw_1234567890abcdef1234567890abcdef',
  });
});

test('invalid workflow JSON fails before upload or source side effects', async () => {
  const state = fixture({ workflowBytes: Buffer.from('{invalid') });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), SyntaxError);
  assert.equal(state.events.some((event) => event[0] === 'upload'), false);
  assert.equal(state.events.some((event) => event[0] === 'stage'), false);
  assert.equal(state.bytes.every((byte) => byte === 0), true);
});

test('commit failure discards only uncommitted source and does not execute', async () => {
  const state = fixture({ commit: async () => { throw new Error('commit failed'); } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), /commit failed/u);
  assert.equal(state.events.some((event) => event[0] === 'execute'), false);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), false);
  assert.equal(state.events.some((event) => event[0] === 'discard'), true);
  assert.deepEqual(state.events.at(-1), ['delete', 'document_1']);
});

test('execution failure retains committed source while cancelling bound execution', async () => {
  const error = Object.assign(new Error('execute failed'), { executionId: 'cw_1234567890abcdef1234567890abcdef' });
  const state = fixture({ execute: async () => { throw error; } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), (value) => value === error);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), true);
  assert.equal(state.events.some((event) => event[0] === 'discard'), false);
});

test('release failure cancels bound execution and retains committed source', async () => {
  const state = fixture({ release: async () => { throw new Error('release failed'); } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), /release failed/u);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), true);
  assert.equal(state.events.some((event) => event[0] === 'discard'), false);
});

test('output failure after release preserves durable handoff and does not cancel', async () => {
  const state = fixture({ output: new Error('stdout failed') });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), /stdout failed/u);
  assert.equal(state.events.some((event) => event[0] === 'release'), true);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), false);
  assert.deepEqual(state.events.at(-1), ['delete', 'document_1']);
});

test('abort during execution preserves source cleanup and temporary document cleanup', async () => {
  const controller = new AbortController();
  const error = Object.assign(new Error('aborted'), { executionId: 'cw_1234567890abcdef1234567890abcdef' });
  const state = fixture({ execute: async () => { controller.abort(); throw error; } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime, controller.signal), /aborted/u);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), true);
  assert.equal(state.events.some((event) => event[0] === 'discard'), false);
  assert.deepEqual(state.events.at(-1), ['delete', 'document_1']);
});
