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

test('successful release hands durable jobs off so close does not cancel them', async () => {
  const state = setup();
  const value = request({ recipe: { id: 'inspect-document-v1', version: 1, repeat: 1 } });
  await state.service.execute(value);
  const releaseRequest = {
    profile: AUTOMATION_JS_PROFILE,
    principal: value.principal,
    grant: value.grant,
    executionId: automationJsExecutionId(normalizeAutomationJsExecuteRequest(value)),
  };
  const receipt = await state.service.release(releaseRequest);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    executionId: releaseRequest.executionId,
    released: true,
    javascriptExecuted: false,
    localOnly: true,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'executionId', 'javascriptExecuted', 'localOnly', 'released', 'schemaVersion',
  ]);
  await state.service.close();
  assert.deepEqual(state.calls.cancel, []);
  await assert.rejects(state.service.release(releaseRequest), {
    code: 'AUTOMATION_JS_CLOSED', status: 409,
  });
});

test('unauthorized or mismatched release does not detach the execution', async () => {
  const mismatched = setup();
  const value = request({ recipe: { id: 'inspect-document-v1', version: 1, repeat: 1 } });
  await mismatched.service.execute(value);
  const executionId = automationJsExecutionId(normalizeAutomationJsExecuteRequest(value));
  await assert.rejects(mismatched.service.release({
    profile: AUTOMATION_JS_PROFILE,
    principal: 'other.caller',
    grant: { grantId: grant.grantId, principal: 'other.caller' },
    executionId,
  }), { code: 'AUTOMATION_JS_NOT_FOUND', status: 404 });
  await mismatched.service.release({
    profile: AUTOMATION_JS_PROFILE,
    principal: value.principal,
    grant: value.grant,
    executionId,
  });
  await mismatched.service.close();
  assert.deepEqual(mismatched.calls.cancel, []);

  const denied = setup({ authority: {
    async authorize(_grant, context) {
      if (context.action === 'automation-js.release') return false;
    },
  } });
  await denied.service.execute(value);
  await assert.rejects(denied.service.release({
    profile: AUTOMATION_JS_PROFILE,
    principal: value.principal,
    grant: value.grant,
    executionId,
  }), { code: 'AUTOMATION_JS_CAPABILITY_DENIED', status: 403 });
  await denied.service.close();
  assert.deepEqual(denied.calls.cancel, ['job_1']);
});

test('failed execution cannot be released', async () => {
  const state = setup({ submit: async () => { throw new Error('queue unavailable'); } });
  const value = request({ recipe: { id: 'inspect-document-v1', version: 1, repeat: 1 } });
  await assert.rejects(state.service.execute(value), /queue unavailable/u);
  const releaseRequest = {
    profile: AUTOMATION_JS_PROFILE,
    principal: value.principal,
    grant: value.grant,
    executionId: automationJsExecutionId(normalizeAutomationJsExecuteRequest(value)),
  };
  await assert.rejects(state.service.release(releaseRequest), /queue unavailable/u);
  await state.service.close();
});

test('replay after release reuses durable API idempotency without widening the recipe', async () => {
  const durable = new Map();
  const state = setup({ submit: async (value, index) => {
    const prior = durable.get(value.idempotencyKey);
    if (prior) return { ...prior, idempotent: true };
    const result = {
      schemaVersion: 1,
      idempotent: false,
      job: { id: `job_${index}`, type: AUTOMATION_INSPECT_TYPE, status: 'pending' },
    };
    durable.set(value.idempotencyKey, result);
    return result;
  } });
  const value = request({ recipe: { id: 'inspect-document-v1', version: 1, repeat: 1 } });
  const first = await state.service.execute(value);
  const releaseRequest = {
    profile: AUTOMATION_JS_PROFILE,
    principal: value.principal,
    grant: value.grant,
    executionId: first.executionId,
  };
  await state.service.release(releaseRequest);
  const replay = await state.service.execute(value);
  assert.deepEqual(replay.jobs.map(({ id }) => id), first.jobs.map(({ id }) => id));
  assert.equal(replay.recipe.repeat, 1);
  assert.equal(state.calls.submit.length, 2);
  assert.equal(durable.size, 1);
  await state.service.release({ ...releaseRequest, executionId: replay.executionId });
  await state.service.close();
  assert.deepEqual(state.calls.cancel, []);
});
