import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_JS_PROFILE,
  automationJsExecutionId,
  normalizeAutomationJsExecuteRequest,
} from '../scripts/host/automation/automation-js-contract.mjs';
import { AutomationJsRecipeRegistry } from '../scripts/host/automation/automation-js-registry.mjs';
import { AutomationJsService } from '../scripts/host/automation/automation-js-service.mjs';
import {
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE,
} from '../scripts/host/automation/automation-operation-contract.mjs';

const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });
const grant = Object.freeze({ grantId: 'grant_local_1', principal: 'caller.one' });

function request(overrides = {}) {
  return {
    profile: AUTOMATION_JS_PROFILE,
    principal: 'caller.one',
    grant,
    source,
    recipe: { id: 'inspect-document-v1', version: 1, repeat: 2 },
    idempotencyKey: 'automation-js-1',
    ...overrides,
  };
}

function setup({ submit = null, cancel = null, authority = null, registry = null } = {}) {
  const calls = { authorize: [], submit: [], cancel: [] };
  const api = {
    async submit(value) {
      calls.submit.push(value);
      if (submit) return submit(value, calls.submit.length);
      const type = value.operation.id === 'inspect-local-v1'
        ? AUTOMATION_INSPECT_TYPE : AUTOMATION_OCR_TYPE;
      return {
        schemaVersion: 1,
        idempotent: false,
        job: { id: `job_${calls.submit.length}`, type, status: 'pending' },
      };
    },
    async cancel(value) {
      calls.cancel.push(value.jobId);
      return cancel?.(value);
    },
  };
  const capabilityAuthority = authority ?? {
    async authorize(value, context) { calls.authorize.push({ value, context }); },
  };
  return {
    service: new AutomationJsService({
      api,
      authority: capabilityAuthority,
      registry: registry ?? new AutomationJsRecipeRegistry(),
    }),
    calls,
  };
}

test('fixed declarative recipe submits only allowlisted operations with deterministic idempotency', async () => {
  const state = setup();
  const result = await state.service.execute(request());
  assert.equal(result.javascriptExecuted, false);
  assert.equal(result.queuedCount, 2);
  assert.deepEqual(state.calls.submit.map(({ operation }) => operation), [
    { kind: 'preset', id: 'inspect-local-v1', pages: null },
    { kind: 'preset', id: 'inspect-local-v1', pages: null },
  ]);
  assert.deepEqual(state.calls.submit.map(({ idempotencyKey }) => idempotencyKey), [
    `automation-js:${result.executionId}:1:inspect`,
    `automation-js:${result.executionId}:2:inspect`,
  ]);
  assert.match(result.limitations.join(' '), /No eval, VM, shell/);
  assert.equal(Object.hasOwn(result, 'grant'), false);
  assert.equal(Object.hasOwn(result, 'script'), false);
  await state.service.close();
});

test('registry is fixed, versioned, and exposes no dynamic registration surface', () => {
  const registry = new AutomationJsRecipeRegistry();
  assert.deepEqual(registry.list().map(({ id }) => id), [
    'assign-cmyk-output-intent-v1', 'inspect-document-v1', 'ocr-english-document-v1',
  ]);
  assert.equal(typeof registry.register, 'undefined');
  assert.throws(() => registry.descriptor('arbitrary-script-v1', 1), {
    code: 'AUTOMATION_JS_RECIPE_DENIED', status: 403,
  });
  assert.equal(Object.isFrozen(registry.descriptor('inspect-document-v1').steps), true);
});

test('untrusted recipe descriptors cannot reach the queue', async () => {
  const proxyState = setup({ registry: {
    descriptor() { return new Proxy({}, { get() { throw new Error('descriptor trap'); } }); },
  } });
  await assert.rejects(proxyState.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } })), { code: 'AUTOMATION_JS_RECIPE_INVALID', status: 502 });
  assert.equal(proxyState.calls.submit.length, 0);
  await proxyState.service.close();

  const unknownState = setup({ registry: { descriptor() { return {
    schemaVersion: 1,
    id: 'inspect-document-v1',
    version: 1,
    steps: [{ id: 'escape', operation: { kind: 'preset', id: 'shell-local-v1', pages: null } }],
  }; } } });
  await assert.rejects(unknownState.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } })), { code: 'AUTOMATION_JS_RECIPE_INVALID', status: 502 });
  assert.equal(unknownState.calls.submit.length, 0);
  await unknownState.service.close();
});

test('contract rejects source code, dynamic fields, proxies, accessors, grant drift, and unbounded repeats', async () => {
  const state = setup();
  assert.throws(() => state.service.execute({ ...request(), script: 'eval(1)' }), {
    code: 'INVALID_AUTOMATION_JS_REQUEST',
  });
  assert.throws(() => state.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 5,
  } })), { code: 'INVALID_AUTOMATION_JS_REQUEST' });
  assert.throws(() => state.service.execute(new Proxy(request(), {})), {
    code: 'INVALID_AUTOMATION_JS_REQUEST',
  });
  const accessor = request();
  Object.defineProperty(accessor, 'recipe', { enumerable: true, get() { throw new Error('trap'); } });
  assert.throws(() => state.service.execute(accessor), { code: 'INVALID_AUTOMATION_JS_REQUEST' });
  assert.throws(() => state.service.execute(request({
    grant: { grantId: grant.grantId, principal: 'other.caller' },
  })), { code: 'INVALID_AUTOMATION_JS_REQUEST' });
  assert.equal(state.calls.submit.length, 0);
  await state.service.close();
});

test('capability denial prevents queue admission and exact contexts contain no executable source', async () => {
  const state = setup({ authority: { async authorize() { return false; } } });
  await assert.rejects(state.service.execute(request()), {
    code: 'AUTOMATION_JS_CAPABILITY_DENIED', status: 403,
  });
  assert.equal(state.calls.submit.length, 0);
  await state.service.close();
});

test('same replay shares one execution and conflicting recipe replay fails closed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ submit: async (value, index) => {
    await gate;
    return { schemaVersion: 1, idempotent: index > 1,
      job: { id: `job_${index}`, type: AUTOMATION_INSPECT_TYPE, status: 'pending' } };
  } });
  const first = state.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } }));
  const second = state.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } }));
  assert.strictEqual(first, second);
  assert.throws(() => state.service.execute(request({ recipe: {
    id: 'ocr-english-document-v1', version: 1, repeat: 1,
  } })), { code: 'AUTOMATION_JS_REPLAY_CONFLICT', status: 409 });
  release();
  assert.strictEqual(await first, await second);
  assert.equal(state.calls.submit.length, 1);
  await state.service.close();
});

test('external cancellation cleans every admitted job exactly once including an in-flight return', async () => {
  let releaseSecond;
  let markSecond;
  const started = new Promise((resolve) => { markSecond = resolve; });
  const gate = new Promise((resolve) => { releaseSecond = resolve; });
  const state = setup({ submit: async (_value, index) => {
    if (index === 2) { markSecond(); await gate; }
    return { schemaVersion: 1, idempotent: false,
      job: { id: `job_${index}`, type: AUTOMATION_INSPECT_TYPE, status: 'pending' } };
  } });
  const controller = new AbortController();
  const value = request();
  const execution = state.service.execute(value, { signal: controller.signal });
  await started;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls.cancel, ['job_1']);
  releaseSecond();
  await assert.rejects(execution, { code: 'AUTOMATION_JS_CANCELLED', status: 499 });
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_2']);
  await state.service.close();
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_2']);
});

test('internal failure cleans prior queue admissions exactly once', async () => {
  const state = setup({ submit: async (_value, index) => {
    if (index === 2) throw new Error('queue unavailable');
    return { schemaVersion: 1, idempotent: false,
      job: { id: 'job_1', type: AUTOMATION_INSPECT_TYPE, status: 'pending' } };
  } });
  await assert.rejects(state.service.execute(request()), /queue unavailable/u);
  assert.deepEqual(state.calls.cancel, ['job_1']);
  await state.service.close();
  assert.deepEqual(state.calls.cancel, ['job_1']);
});

test('failed cancellation remains retryable and only success is terminal', async () => {
  let attempts = 0;
  const state = setup({ cancel: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient cancel failure');
  } });
  const value = request({ recipe: { id: 'inspect-document-v1', version: 1, repeat: 1 } });
  await state.service.execute(value);
  const cancelRequest = {
    profile: AUTOMATION_JS_PROFILE,
    principal: value.principal,
    grant: value.grant,
    executionId: automationJsExecutionId(normalizeAutomationJsExecuteRequest(value)),
  };
  await assert.rejects(state.service.cancel(cancelRequest), /transient cancel failure/u);
  await state.service.cancel(cancelRequest);
  await state.service.close();
  assert.deepEqual(state.calls.cancel, ['job_1', 'job_1']);

  let closeAttempts = 0;
  const closeRetry = setup({ cancel: async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error('retry on close');
  } });
  await closeRetry.service.execute(value);
  await assert.rejects(closeRetry.service.cancel(cancelRequest), /retry on close/u);
  await closeRetry.service.close();
  assert.deepEqual(closeRetry.calls.cancel, ['job_1', 'job_1']);
});

test('concurrent close is deduplicated and a failed close remains retryable', async () => {
  let attempts = 0;
  let releaseFirst;
  let markFirst;
  const firstStarted = new Promise((resolve) => { markFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const state = setup({ cancel: async () => {
    attempts += 1;
    if (attempts === 1) { markFirst(); await firstGate; throw new Error('close cancel one'); }
    if (attempts === 2) throw new Error('close cancel two');
  } });
  await state.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } }));
  const first = state.service.close();
  await firstStarted;
  const concurrent = state.service.close();
  assert.throws(() => state.service.execute(request({ idempotencyKey: 'after-close' })), {
    code: 'AUTOMATION_JS_CLOSED', status: 409,
  });
  releaseFirst();
  const results = await Promise.allSettled([first, concurrent]);
  assert.deepEqual(results.map(({ status }) => status), ['rejected', 'rejected']);
  assert.strictEqual(results[0].reason, results[1].reason);
  assert.match(results[0].reason.message, /close cancel two/u);
  assert.equal(attempts, 2);

  await state.service.close();
  assert.equal(attempts, 3);
  await state.service.close();
  assert.equal(attempts, 3);
});

test('explicit cancellation is principal/grant bound and forged queue output fails closed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ submit: async () => {
    await gate;
    return { schemaVersion: 1, idempotent: false,
      job: { id: 'job_1', type: AUTOMATION_INSPECT_TYPE, status: 'pending' } };
  } });
  const value = request({ recipe: { id: 'inspect-document-v1', version: 1, repeat: 1 } });
  const pending = state.service.execute(value);
  await new Promise((resolve) => setImmediate(resolve));
  const executionId = automationJsExecutionId(normalizeAutomationJsExecuteRequest(value));
  await assert.rejects(state.service.cancel({
    profile: AUTOMATION_JS_PROFILE,
    principal: 'other.caller',
    grant: { grantId: grant.grantId, principal: 'other.caller' },
    executionId,
  }), { code: 'AUTOMATION_JS_NOT_FOUND', status: 404 });
  release();
  await pending;
  await state.service.close();

  const forged = setup({
    submit: async () => ({
      schemaVersion: 1,
      idempotent: false,
      job: { id: 'job_1', type: 'not_allowlisted', status: 'pending' },
    }),
    cancel: async (value) => assert.deepEqual(value, {
      principal: 'caller.one', grant, jobId: 'job_1',
    }),
  });
  await assert.rejects(forged.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } })), { code: 'AUTOMATION_JS_QUEUE_RESULT_INVALID', status: 502 });
  assert.deepEqual(forged.calls.cancel, ['job_1']);
  await forged.service.close();
  assert.deepEqual(forged.calls.cancel, ['job_1']);

  let trapped = false;
  const unsafeJob = { id: 'job_accessor', status: 'pending' };
  Object.defineProperty(unsafeJob, 'type', { enumerable: true, get() {
    trapped = true;
    throw new Error('queue type trap');
  } });
  const accessorForged = setup({ submit: async () => ({
    schemaVersion: 1, idempotent: false, job: unsafeJob,
  }) });
  await assert.rejects(accessorForged.service.execute(request({ recipe: {
    id: 'inspect-document-v1', version: 1, repeat: 1,
  } })), { code: 'AUTOMATION_JS_QUEUE_RESULT_INVALID', status: 502 });
  assert.equal(trapped, false);
  assert.deepEqual(accessorForged.calls.cancel, ['job_accessor']);
  await accessorForged.service.close();
});
