import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  conditionalExecutionId,
  normalizeAutomationConditionalExecuteRequest,
} from '../scripts/host/automation/automation-conditional-workflow-contract.mjs';
import { AutomationConditionalWorkflowService } from '../scripts/host/automation/automation-conditional-workflow-service.mjs';
import { LocalConditionalWorkflowFactsProvider } from '../scripts/host/automation/automation-conditional-workflow-runtime.mjs';
import { AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE } from '../scripts/host/automation/automation-operation-contract.mjs';

const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });
const grant = Object.freeze({ grantId: 'grant_local_1', principal: 'caller.one' });
const inspect = Object.freeze({ kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null });
const ocr = Object.freeze({ kind: 'operation', id: AUTOMATION_OCR_TYPE, pages: null });
const empty = Object.freeze({ operation: null, repeat: 1 });
const op = (operation, repeat = 1) => Object.freeze({ operation, repeat });

function workflow(steps = null) {
  return {
    workflowId: 'workflow_1',
    steps: steps ?? [{
      stepId: 'large', condition: { field: 'document.pageCount', operator: 'gte', value: 3 },
      trueBranch: op(inspect, 2), falseBranch: empty,
    }, {
      stepId: 'after', condition: { field: 'workflow.previousStatus', operator: 'eq', value: 'queued' },
      trueBranch: op(ocr), falseBranch: empty,
    }],
  };
}

function request(overrides = {}) {
  return { principal: 'caller.one', grant, source, workflow: workflow(), idempotencyKey: 'conditional-1', ...overrides };
}

function releaseRequest(value, executionId = conditionalExecutionId(normalizeAutomationConditionalExecuteRequest(value))) {
  return { principal: value.principal, grant: value.grant, executionId };
}

function setup({ facts = null, authority = null, submit = null, cancel = null } = {}) {
  const calls = { authorize: [], facts: 0, submit: [], cancel: [] };
  const api = { async submit(value) {
    calls.submit.push(value);
    if (submit) return submit(value, calls.submit.length);
    return { schemaVersion: 1, idempotent: false, job: { id: `job_${calls.submit.length}`, type: value.operation.id, status: 'pending' } };
  }, async cancel(value) { calls.cancel.push(value.jobId); if (cancel) return cancel(value); } };
  const factsProvider = { async inspectVerified(binding) {
    calls.facts += 1;
    return facts ?? { source: binding, pageCount: 4, encrypted: false, tagged: true, optimized: false };
  } };
  const capabilityAuthority = authority ?? { async authorize(value, context) { calls.authorize.push({ value, context }); } };
  return { service: new AutomationConditionalWorkflowService({ api, authority: capabilityAuthority, factsProvider }), calls };
}

test('conditional workflow branches and fixed repeats with deterministic queue idempotency', async () => {
  const state = setup();
  const result = await state.service.execute(request());
  assert.equal(result.status, 'completed');
  assert.equal(result.queuedCount, 3);
  assert.deepEqual(result.steps.map((step) => step.status), ['queued', 'queued']);
  assert.deepEqual(state.calls.submit.map((item) => item.idempotencyKey), [
    `${result.executionId}:x`,
  ].flatMap(() => [
    `conditional:${result.executionId}:large:true:1`,
    `conditional:${result.executionId}:large:true:2`,
    `conditional:${result.executionId}:after:true:1`,
  ]));
  assert.equal(Object.hasOwn(result, 'grant'), false);
  await state.service.close();
});

test('unknown verified evidence defaults to the false branch and status conditions remain finite', async () => {
  const state = setup({ facts: { source, pageCount: 4, encrypted: null, tagged: null, optimized: null } });
  const result = await state.service.execute(request({ workflow: workflow([{
    stepId: 'encrypted', condition: { field: 'document.encrypted', operator: 'eq', value: true },
    trueBranch: op(ocr), falseBranch: op(inspect),
  }]) }));
  assert.equal(result.steps[0].branch, 'false');
  assert.equal(state.calls.submit[0].operation.id, AUTOMATION_INSPECT_TYPE);
  await state.service.close();
});

test('contracts reject proxies, accessors, unknown fields, and unbounded repeats before side effects', async () => {
  const state = setup();
  assert.throws(() => state.service.execute(new Proxy(request(), {})), { code: 'INVALID_AUTOMATION_CONDITIONAL_WORKFLOW' });
  const accessor = request();
  Object.defineProperty(accessor, 'workflow', { enumerable: true, get() { throw new Error('trap'); } });
  assert.throws(() => state.service.execute(accessor), { code: 'INVALID_AUTOMATION_CONDITIONAL_WORKFLOW' });
  const invalid = request({ workflow: workflow([{ stepId: 'bad', condition: { field: 'document.path', operator: 'eq', value: true }, trueBranch: op(inspect, 4), falseBranch: empty }]) });
  assert.throws(() => state.service.execute(invalid), { code: 'AUTOMATION_CONDITION_DENIED' });
  assert.equal(state.calls.facts, 0);
  assert.equal(state.calls.submit.length, 0);
  await state.service.close();
});

test('authority denial and verified source drift prevent all queue admission', async () => {
  const denied = setup({ authority: { async authorize() { return false; } } });
  await assert.rejects(denied.service.execute(request()), { code: 'AUTOMATION_CONDITIONAL_CAPABILITY_DENIED' });
  assert.equal(denied.calls.facts, 0);
  assert.equal(denied.calls.submit.length, 0);
  const drift = setup({ facts: { source: { id: source.id, sha256: 'b'.repeat(64) }, pageCount: 1, encrypted: false, tagged: false, optimized: false } });
  await assert.rejects(drift.service.execute(request()), { code: 'AUTOMATION_CONDITIONAL_SOURCE_DRIFT' });
  assert.equal(drift.calls.submit.length, 0);
  await denied.service.close(); await drift.service.close();
});

test('same concurrent replay shares one execution while conflicting replay fails closed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ facts: null, submit: async (value, index) => { await gate; return { schemaVersion: 1, idempotent: index > 1, job: { id: `job_${index}`, type: value.operation.id, status: 'pending' } }; } });
  const first = state.service.execute(request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) }));
  const second = state.service.execute(request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) }));
  assert.throws(() => state.service.execute(request({ workflow: workflow([{ stepId: 'other', condition: { field: 'document.pageCount', operator: 'eq', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) })), { code: 'AUTOMATION_CONDITIONAL_REPLAY_CONFLICT' });
  release();
  assert.strictEqual(await first, await second);
  assert.equal(state.calls.submit.length, 1);
  await state.service.close();
});

test('cancellation stops later bounded iterations and forged queue results are rejected', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ submit: async (value) => { await gate; return { schemaVersion: 1, idempotent: false, job: { id: 'job_1', type: value.operation.id, status: 'pending' } }; } });
  const value = request({ workflow: workflow([{ stepId: 'repeat', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect, 2), falseBranch: empty }]) });
  const execution = state.service.execute(value);
  await new Promise((resolve) => setImmediate(resolve));
  const executionId = conditionalExecutionId(normalizeAutomationConditionalExecuteRequest(value));
  const cancelled = await state.service.cancel({ principal: grant.principal, grant, executionId });
  assert.equal(cancelled.cancelled, true);
  release();
  await assert.rejects(execution, { code: 'AUTOMATION_CONDITIONAL_CANCELLED' });
  assert.equal(state.calls.submit.length, 1);
  await state.service.close();

  const forged = setup({ submit: async () => ({ schemaVersion: 1, idempotent: false, job: { id: 'job_1', type: 'wrong_type', status: 'pending' } }) });
  await assert.rejects(forged.service.execute(request()), { code: 'AUTOMATION_CONDITIONAL_QUEUE_RESULT_INVALID' });
  await forged.service.close();
});

test('local facts provider verifies the source and cleans its temporary document', async () => {
  let deleted = null;
  const provider = new LocalConditionalWorkflowFactsProvider({
    sources: { async openVerified() { return { ...source, size: 5, stream: Readable.from([Buffer.from('%PDF-')]) }; } },
    store: {
      async createDocument() { return { id: 'document_1', sha256: source.sha256, size: 5 }; },
      async deleteDocument(id) { deleted = id; },
    },
    service: { async inspect() { return { pageCount: 2, pdfVersion: '1.7', encrypted: 'no', tagged: 'yes', optimized: 'no' }; } },
  });
  const facts = await provider.inspectVerified(source);
  assert.deepEqual(facts, { source, pageCount: 2, encrypted: false, optimized: false, tagged: true });
  assert.equal(deleted, 'document_1');
});

test('external abort cancels every admitted job exactly once, including an in-flight return', async () => {
  let releaseSecond;
  let markSecond;
  const secondStarted = new Promise((resolve) => { markSecond = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const state = setup({ submit: async (value, index) => {
    if (index === 2) { markSecond(); await secondGate; }
    return { schemaVersion: 1, idempotent: false, job: { id: `job_${index}`, type: value.operation.id, status: 'pending' } };
  } });
  const controller = new AbortController();
  const value = request({ workflow: workflow([{ stepId: 'repeat', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect, 2), falseBranch: empty }]) });
  const execution = state.service.execute(value, { signal: controller.signal });
  await secondStarted;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls.cancel, ['job_1']);
  releaseSecond();
  await assert.rejects(execution, { code: 'AUTOMATION_CONDITIONAL_CANCELLED' });
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_2']);
  await state.service.close();
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_2']);
});

test('close aborts active executions and cancels all admitted jobs without duplicates', async () => {
  let releaseSecond;
  let markSecond;
  const secondStarted = new Promise((resolve) => { markSecond = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const state = setup({ submit: async (value, index) => {
    if (index === 2) { markSecond(); await secondGate; }
    return { schemaVersion: 1, idempotent: false, job: { id: `job_${index}`, type: value.operation.id, status: 'pending' } };
  } });
  const value = request({ workflow: workflow([{ stepId: 'repeat', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect, 2), falseBranch: empty }]) });
  const execution = state.service.execute(value);
  const rejected = assert.rejects(execution, { code: 'AUTOMATION_CONDITIONAL_CANCELLED' });
  await secondStarted;
  const closing = state.service.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls.cancel, ['job_1']);
  releaseSecond();
  await rejected;
  await closing;
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_2']);
});

test('internal failure retries transient queued-job cleanup on close', async () => {
  const primary = Object.assign(new Error('queue failed'), { code: 'QUEUE_FAILED' });
  const cleanup = Object.assign(new Error('cancel failed'), { code: 'CANCEL_FAILED' });
  let cancellationAttempts = 0;
  const state = setup({
    submit: async (value, index) => {
      if (index === 2) throw primary;
      return { schemaVersion: 1, idempotent: false, job: { id: 'job_1', type: value.operation.id, status: 'pending' } };
    },
    cancel: async () => {
      cancellationAttempts += 1;
      if (cancellationAttempts === 1) throw cleanup;
    },
  });
  const value = request({ workflow: workflow([{ stepId: 'first', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty },
    { stepId: 'second', condition: { field: 'workflow.previousStatus', operator: 'eq', value: 'queued' }, trueBranch: op(inspect), falseBranch: empty }]) });
  await assert.rejects(state.service.execute(value), (error) => {
    assert(error instanceof AggregateError);
    assert.strictEqual(error.errors[0], primary);
    assert.strictEqual(error.errors[1], cleanup);
    return true;
  });
  assert.deepEqual(state.calls.cancel, ['job_1']);
  await assert.rejects(state.service.close(), (error) => error === cleanup);
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_1']);
});

test('successful release hands durable jobs off so close does not cancel them', async () => {
  const state = setup();
  const value = request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) });
  const result = await state.service.execute(value);
  const receipt = await state.service.release(releaseRequest(value, result.executionId));
  assert.deepEqual(receipt, { schemaVersion: 1, executionId: result.executionId, released: true, localOnly: true });
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(receipt).sort(), ['executionId', 'localOnly', 'released', 'schemaVersion']);
  await state.service.close();
  assert.deepEqual(state.calls.cancel, []);
  await assert.rejects(state.service.release(releaseRequest(value, result.executionId)), { code: 'AUTOMATION_CONDITIONAL_CLOSED', status: 409 });
});

test('unauthorized or mismatched release does not detach the execution', async () => {
  const mismatched = setup();
  const value = request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) });
  const result = await mismatched.service.execute(value);
  await assert.rejects(mismatched.service.release({
    principal: 'other.caller', grant: { grantId: grant.grantId, principal: 'other.caller' }, executionId: result.executionId,
  }), { code: 'AUTOMATION_CONDITIONAL_NOT_FOUND', status: 404 });
  await mismatched.service.release(releaseRequest(value, result.executionId));
  await mismatched.service.close();
  assert.deepEqual(mismatched.calls.cancel, []);

  const denied = setup({ authority: {
    async authorize(_grant, context) {
      if (context.action === 'conditional.release') return false;
    },
  } });
  const deniedResult = await denied.service.execute(value);
  await assert.rejects(denied.service.release(releaseRequest(value, deniedResult.executionId)), {
    code: 'AUTOMATION_CONDITIONAL_CAPABILITY_DENIED', status: 403,
  });
  await denied.service.close();
  assert.deepEqual(denied.calls.cancel, ['job_1']);
});

test('failed execution cannot be released', async () => {
  const state = setup({ submit: async () => { throw new Error('queue unavailable'); } });
  const value = request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) });
  await assert.rejects(state.service.execute(value), /queue unavailable/u);
  await assert.rejects(state.service.release(releaseRequest(value)), /queue unavailable/u);
  await state.service.close();
});

test('replay after release reuses durable API idempotency without widening the workflow', async () => {
  const durable = new Map();
  const state = setup({ submit: async (value, index) => {
    const prior = durable.get(value.idempotencyKey);
    if (prior) return { ...prior, idempotent: true };
    const result = { schemaVersion: 1, idempotent: false, job: { id: `job_${index}`, type: value.operation.id, status: 'pending' } };
    durable.set(value.idempotencyKey, result);
    return result;
  } });
  const value = request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) });
  const first = await state.service.execute(value);
  await state.service.release(releaseRequest(value, first.executionId));
  const replay = await state.service.execute(value);
  assert.deepEqual(replay.steps.flatMap(({ jobs }) => jobs).map(({ id }) => id), first.steps.flatMap(({ jobs }) => jobs).map(({ id }) => id));
  assert.equal(replay.workflowId, first.workflowId);
  assert.equal(replay.queuedCount, first.queuedCount);
  assert.equal(state.calls.submit.length, 2);
  assert.equal(durable.size, 1);
  await state.service.release(releaseRequest(value, replay.executionId));
  await state.service.close();
  assert.deepEqual(state.calls.cancel, []);
});

test('cancel authorizes once with the bound source and workflow', async () => {
  const state = setup();
  const value = request({ workflow: workflow([{ stepId: 'one', condition: { field: 'document.pageCount', operator: 'gte', value: 1 }, trueBranch: op(inspect), falseBranch: empty }]) });
  const result = await state.service.execute(value);
  const before = state.calls.authorize.length;
  await state.service.cancel(releaseRequest(value, result.executionId));
  const cancelCalls = state.calls.authorize.slice(before);
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0].context.action, 'conditional.cancel');
  assert.deepEqual(cancelCalls[0].context.source, source);
  assert.equal(cancelCalls[0].context.workflowId, value.workflow.workflowId);
  await state.service.close();
});
