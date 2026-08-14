import assert from 'node:assert/strict';
import test from 'node:test';
import { runAutomationCommand } from '../scripts/cli/commands/automation.mjs';
import { AUTOMATION_JS_PROFILE } from '../scripts/host/automation/automation-js-contract.mjs';
import {
  AUTOMATION_RECIPE_CLI_GRANT,
  AUTOMATION_RECIPE_CLI_PRINCIPAL,
} from '../scripts/cli/automation-recipe-authority.mjs';

const command = (overrides = {}) => ({
  command: 'automation-run-recipe', input: 'input.pdf', automationRoot: 'private',
  recipe: 'inspect-document-v1', repeat: 2, idempotencyKey: null, output: null,
  ...overrides,
});

function fixture({ source = { id: 'source_1', sha256: 'a'.repeat(64), size: 12 }, execute = null,
  release = null, output = null, stage = null } = {}) {
  const events = [];
  const document = { id: 'document_1', sha256: 'a'.repeat(64), size: 12 };
  const staged = stage ?? (async () => { events.push('stage'); return source; });
  const application = {
    store: {
      async deleteDocument(id) { events.push(['delete', id]); },
    },
    automation: {
      sources: {
        async stageDocument(value) { return staged(value, events); },
        async commit(value) { events.push(['commit', value.id]); },
        async discardCreated(value) { events.push(['discard', value.id]); return true; },
      },
      automationJs: {
        async execute(value) { events.push(['execute', value]); return execute ? execute(value, events) : { executionId: 'ajs_execution_1', queuedCount: 1, javascriptExecuted: false }; },
        async cancel(value) { events.push(['cancel', value]); },
        async release(value) { events.push(['release', value]); return release ? release(value, events) : { executionId: value.executionId, released: true, javascriptExecuted: false }; },
      },
    },
  };
  const runtime = {
    async uploadPdf() { events.push('upload'); return document; },
    cancelled() {},
    async outputValue(_command, _stdout, value) { events.push(['output', value]); if (output) throw output; },
  };
  return { application, runtime, events, document };
}

test('recipe command builds deterministic default request and commits before admission and release', async () => {
  const first = fixture();
  await runAutomationCommand(first.application, command(), {}, first.runtime);
  const second = fixture();
  await runAutomationCommand(second.application, command(), {}, second.runtime);
  const requestA = first.events.find((event) => event[0] === 'execute')[1];
  const requestB = second.events.find((event) => event[0] === 'execute')[1];
  assert.deepEqual(requestA, requestB);
  assert.deepEqual(requestA, {
    profile: AUTOMATION_JS_PROFILE,
    principal: AUTOMATION_RECIPE_CLI_PRINCIPAL,
    grant: AUTOMATION_RECIPE_CLI_GRANT,
    source: { id: 'source_1', sha256: 'a'.repeat(64) },
    recipe: { id: 'inspect-document-v1', version: 1, repeat: 2 },
    idempotencyKey: `automation-recipe:${'a'.repeat(64)}:inspect-document-v1:1:2`,
  });
  assert.ok(first.events.findIndex((event) => event[0] === 'commit') < first.events.findIndex((event) => event[0] === 'execute'));
  assert.ok(first.events.findIndex((event) => event[0] === 'execute') < first.events.findIndex((event) => event[0] === 'release'));
  assert.equal(first.events.find((event) => event[0] === 'output')[1].kind, 'automation-declarative-recipe-run');
});

test('explicit key is preserved and digest-deduplicated source is not discarded', async () => {
  const state = fixture({ stage: async (_value, events) => { events.push('stage'); return { id: 'existing_source', sha256: 'a'.repeat(64), size: 12 }; } });
  await runAutomationCommand(state.application, command({ idempotencyKey: 'user-key-1' }), {}, state.runtime);
  const request = state.events.find((event) => event[0] === 'execute')[1];
  assert.equal(request.idempotencyKey, 'user-key-1');
  assert.equal(state.events.some((event) => event[0] === 'discard'), false);
});

test('execution failure cancels admitted work and retains the committed durable source', async () => {
  const error = Object.assign(new Error('execute failed'), { executionId: 'ajs_execution_1' });
  const state = fixture({ execute: async () => { throw error; } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), (value) => value === error);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), true);
  assert.equal(state.events.some((event) => event[0] === 'discard'), false);
  assert.deepEqual(state.events.at(-1), ['delete', 'document_1']);
});

test('commit failure happens before admission and discards only the uncommitted source', async () => {
  const state = fixture();
  state.application.automation.sources.commit = async () => { state.events.push('commit-failed'); throw new Error('commit failed'); };
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), /commit failed/u);
  assert.equal(state.events.some((event) => event[0] === 'execute'), false);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), false);
  assert.equal(state.events.some((event) => event[0] === 'discard'), true);
});

test('release failure cancels admitted work while retaining committed source', async () => {
  const state = fixture({ release: async () => { throw new Error('release failed'); } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), /release failed/u);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), true);
  assert.equal(state.events.some((event) => event[0] === 'discard'), false);
});

test('abort during execute follows cancellation cleanup', async () => {
  const controller = new AbortController();
  const error = Object.assign(new Error('aborted'), { executionId: 'ajs_execution_1' });
  const state = fixture({ execute: async () => { controller.abort(); throw error; } });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime, controller.signal), /aborted/u);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), true);
  assert.deepEqual(state.events.at(-1), ['delete', 'document_1']);
});

test('output failure after release preserves durable handoff and does not cancel', async () => {
  const state = fixture({ output: new Error('stdout failed') });
  await assert.rejects(runAutomationCommand(state.application, command(), {}, state.runtime), /stdout failed/u);
  assert.equal(state.events.some((event) => event[0] === 'release'), true);
  assert.equal(state.events.some((event) => event[0] === 'cancel'), false);
  assert.deepEqual(state.events.at(-1), ['delete', 'document_1']);
});
