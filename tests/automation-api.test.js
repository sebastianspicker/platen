import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_PRESET,
} from '../scripts/host/automation/automation-operation-contract.mjs';
import {
  AutomationApiService,
  normalizeAutomationApiSubmitRequest,
} from '../scripts/host/automation/automation-api-service.mjs';
import {
  normalizeAutomationApiOutputRequest,
  normalizeAutomationApiStatusRequest,
  publicAutomationApiReceipt,
} from '../scripts/host/automation/automation-api-contract.mjs';
import { HostError } from '../scripts/host/host-error.mjs';

const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const grant = Object.freeze({ grantId: 'grant_local_1', principal: 'caller.one' });
const source = Object.freeze({ id: 'source_1', sha256: sourceSha256 });

function request(overrides = {}) {
  return {
    principal: 'caller.one', grant,
    source,
    operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null },
    idempotencyKey: 'request-1',
    ...overrides,
  };
}

function job(status = 'pending', receipt = null) {
  return {
    id: 'job_1', type: AUTOMATION_INSPECT_TYPE, payload: {}, status,
    attempts: 0, maxAttempts: 8, createdAt: 1, updatedAt: 1,
    lease: null, retry: null, receipt,
    transaction: { source: { kind: 'source', id: source.id, sha256: source.sha256, size: 10, sourceId: source.id, sourceSha256 }, output: null },
  };
}

function setup({ queueOverrides = {}, authority = null, worker = null, sourceOverrides = {}, outputMetadata = null } = {}) {
  const calls = { authorize: [], opened: 0, enqueued: [], cancelled: [], committed: [] };
  const jobs = new Map();
  const queue = {
    async enqueue(value) {
      calls.enqueued.push(value);
      const queued = { ...job(), type: value.type, payload: value.payload,
        transaction: { source: value.transaction, output: null } };
      jobs.set(value.idempotencyKey, queued);
      return { job: queued, idempotent: false };
    },
    async admission(key) { return { accepting: true, existing: jobs.get(key) ?? null }; },
    async get() { return job(); },
    async cancel(id) { calls.cancelled.push(id); return job('cancelled'); },
    ...queueOverrides,
  };
  const registry = {
    enqueueRequest: (value) => ({ type: AUTOMATION_INSPECT_TYPE, payload: { sourceId: value.id, sha256: value.sha256 } }),
    enqueuePresetRequest: (value, id) => ({ type: 'automation_ocr_v1', payload: { sourceId: value.id, sha256: value.sha256, preset: id } }),
    enqueueSequenceRequest: (value, id) => ({ type: 'automation_sequence_v1', payload: { sourceId: value.id, sha256: value.sha256, sequenceId: id, sequenceVersion: 1 } }),
    enqueueOcrRequest: (value) => ({ type: 'automation_ocr_v1', payload: { sourceId: value.id, sha256: value.sha256, language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [] } }),
    enqueueOutputIntentRequest: (value) => ({ type: 'automation_output_intent_v1', payload: { sourceId: value.id, sha256: value.sha256, profile: 'local-ghostscript-default-cmyk-output-intent-v1' } }),
    enqueueFullPageRedactionRequest: (value, options) => ({ type: 'automation_full_page_redaction_v1', payload: { sourceId: value.id, sha256: value.sha256, pages: options.pages } }),
  };
  const sources = {
    async openVerified(id, sha256) { calls.opened += 1; assert.equal(id, source.id); assert.equal(sha256, source.sha256); return { id, sha256, size: 10, stream: Readable.from([]) }; },
    async commit(value) { calls.committed.push(value); },
    async getOutputMetadata() { return outputMetadata ?? { id: 'output_1', sha256: outputSha256, size: 10, sourceId: source.id, sourceSha256 }; },
    ...sourceOverrides,
  };
  const capabilityAuthority = authority ?? { async authorize(value, context) { calls.authorize.push({ value, context }); } };
  return { api: new AutomationApiService({ queue, registry, sources, worker, authority: capabilityAuthority, sleep: async () => {} }), calls };
}

test('automation API submits only an allowlisted operation and returns a redacted public job', async () => {
  const state = setup();
  const result = await state.api.submit(request());
  assert.equal(result.idempotent, false);
  assert.deepEqual(result.job, {
    id: 'job_1', type: AUTOMATION_INSPECT_TYPE, status: 'pending', attempts: 0,
    maxAttempts: 8, createdAt: 1, updatedAt: 1, retry: null, receipt: null,
  });
  assert.equal(state.calls.authorize[0].context.capability, 'automation.submit');
  assert.equal(state.calls.enqueued[0].idempotencyKey, 'request-1');
  assert.deepEqual(state.calls.enqueued[0].transaction, {
    kind: 'source', id: source.id, sha256: source.sha256, size: 10,
    sourceId: source.id, sourceSha256: source.sha256,
  });
  assert.equal(state.calls.committed.length, 1);
  assert.equal(Object.hasOwn(result.job, 'payload'), false);
});

test('automation API confirms an ambiguously acknowledged durable admission before committing source', async () => {
  let stored = null;
  const state = setup({ queueOverrides: {
    async enqueue(value) {
      stored = { ...job(), type: value.type, payload: value.payload,
        transaction: { source: value.transaction, output: null } };
      throw new Error('post-write acknowledgement failed');
    },
    async admission() { return { accepting: true, existing: stored }; },
  } });
  const result = await state.api.submit(request());
  assert.equal(result.idempotent, true);
  assert.equal(result.job.id, 'job_1');
  assert.equal(state.calls.committed.length, 1);
});

test('automation API rejects proxies, accessors, and extra request fields before authority or source access', async () => {
  const state = setup();
  const accessor = request();
  Object.defineProperty(accessor, 'principal', { get() { throw new Error('must not run'); }, enumerable: true });
  await assert.rejects(state.api.submit(accessor), { code: 'INVALID_AUTOMATION_API_REQUEST' });
  await assert.rejects(state.api.submit(new Proxy(request(), {})), { code: 'INVALID_AUTOMATION_API_REQUEST' });
  await assert.rejects(state.api.submit({ ...request(), extra: true }), { code: 'INVALID_AUTOMATION_API_REQUEST' });
  assert.equal(state.calls.opened, 0);
  assert.equal(state.calls.authorize.length, 0);
});

test('automation API rejects confused-deputy grants and does not inspect the source', async () => {
  const state = setup();
  await assert.rejects(state.api.submit(request({ principal: 'other', grant })), { code: 'AUTOMATION_API_GRANT_MISMATCH' });
  assert.equal(state.calls.opened, 0);
  await assert.rejects(state.api.submit(request({ grant: { grantId: 'grant_local_1', principal: 'other' } })), { code: 'AUTOMATION_API_GRANT_MISMATCH' });
});

test('automation API maps unauthorized authority, forged jobs, and replay conflicts deterministically', async () => {
  const denied = setup({ authority: { authorize() { throw new HostError('WRONG_CODE', 'denied', 500); } } });
  await assert.rejects(denied.api.submit(request()), { code: 'AUTOMATION_API_CAPABILITY_DENIED', status: 403 });
  const forged = setup({ queueOverrides: { async get() { throw new HostError('QUEUE_JOB_NOT_FOUND', 'gone', 404); } } });
  await assert.rejects(forged.api.status({ principal: 'caller.one', grant, jobId: 'forged_job' }), { code: 'AUTOMATION_API_RESOURCE_NOT_FOUND', status: 404 });
  const replay = setup({ queueOverrides: { async enqueue() { throw new HostError('IDEMPOTENCY_CONFLICT', 'conflict', 409); } } });
  await assert.rejects(replay.api.submit(request()), { code: 'AUTOMATION_API_REPLAY_CONFLICT', status: 409 });
});

test('automation API cancellation and bounded polling use only the job lifecycle', async () => {
  const state = setup();
  await state.api.submit(request());
  const cancelled = await state.api.cancel({ principal: 'caller.one', grant, jobId: 'job_1' });
  assert.equal(cancelled.status, 'pending');
  assert.deepEqual(state.calls.cancelled, ['job_1']);
  const polled = await state.api.poll({ principal: 'caller.one', grant, jobId: 'job_1', maxWaitMs: 0 });
  assert.equal(polled.id, 'job_1');
  await assert.rejects(state.api.poll({ principal: 'caller.one', grant, jobId: 'job_1', maxWaitMs: 10_001 }), { code: 'INVALID_AUTOMATION_API_REQUEST' });
});

test('automation API output metadata is digest-bound and never returns paths or bytes', async () => {
  const state = setup({ queueOverrides: { async get() { return job('completed', { durableOutput: { id: 'output_1', sha256: outputSha256, size: 10 } }); } } });
  await state.api.submit(request());
  await state.api.status({ principal: 'caller.one', grant, jobId: 'job_1' });
  const metadata = await state.api.output({ principal: 'caller.one', grant, jobId: 'job_1', outputId: 'output_1', outputSha256 });
  assert.deepEqual(metadata, { id: 'output_1', sha256: outputSha256, size: 10, sourceId: source.id, sourceSha256 });
  assert.equal(Object.hasOwn(metadata, 'filePath'), false);
  await assert.rejects(state.api.output({ principal: 'caller.one', grant, jobId: 'job_1', outputId: 'output_1', outputSha256: 'c'.repeat(64) }), { code: 'AUTOMATION_API_RESOURCE_NOT_FOUND' });
});

test('automation API canonical request helper rejects unsupported preset and preserves exact preset selection', () => {
  const normalized = normalizeAutomationApiSubmitRequest(request({ operation: { kind: 'preset', id: AUTOMATION_OCR_PRESET, pages: null } }));
  assert.equal(normalized.operation.id, AUTOMATION_OCR_PRESET);
  assert.throws(() => normalizeAutomationApiSubmitRequest(request({ operation: { kind: 'preset', id: 'not-allowlisted', pages: null } })), { code: 'AUTOMATION_API_OPERATION_DENIED' });
});

test('automation API binds every resource operation to the submitting principal', async () => {
  const otherGrant = Object.freeze({ grantId: 'grant_other_1', principal: 'caller.two' });
  const state = setup({ queueOverrides: {
    async get() { return job('completed', { durableOutput: { id: 'output_1', sha256: outputSha256, size: 10 } }); },
  } });
  await state.api.submit(request());
  await state.api.status({ principal: 'caller.one', grant, jobId: 'job_1' });
  await assert.rejects(state.api.status({ principal: 'caller.two', grant: otherGrant, jobId: 'job_1' }), { code: 'AUTOMATION_API_RESOURCE_NOT_FOUND' });
  await assert.rejects(state.api.poll({ principal: 'caller.two', grant: otherGrant, jobId: 'job_1', maxWaitMs: 0 }), { code: 'AUTOMATION_API_RESOURCE_NOT_FOUND' });
  await assert.rejects(state.api.cancel({ principal: 'caller.two', grant: otherGrant, jobId: 'job_1' }), { code: 'AUTOMATION_API_RESOURCE_NOT_FOUND' });
  await assert.rejects(state.api.output({ principal: 'caller.two', grant: otherGrant, jobId: 'job_1', outputId: 'output_1', outputSha256 }), { code: 'AUTOMATION_API_RESOURCE_NOT_FOUND' });
  await assert.rejects(state.api.submit(request({ principal: 'caller.two', grant: otherGrant })), { code: 'AUTOMATION_API_REPLAY_CONFLICT' });
});

test('automation API rejects accessor or proxy queue receipts before ownership traversal', async () => {
  let trapped = false;
  const receipt = new Proxy({ durableOutput: { id: 'output_1', sha256: outputSha256, size: 10 } }, {
    get() { trapped = true; throw new Error('receipt trap'); },
  });
  const state = setup({ queueOverrides: { async get() { return job('completed', receipt); } } });
  await state.api.submit(request());
  await assert.rejects(state.api.status({ principal: 'caller.one', grant, jobId: 'job_1' }), { code: 'AUTOMATION_API_RESULT_INVALID' });
  assert.equal(trapped, false);
});

test('automation API rejects a same-principal job-ID replay with a different request fingerprint', async () => {
  const state = setup();
  await state.api.submit(request());
  await assert.rejects(state.api.submit(request({ idempotencyKey: 'request-2' })), { code: 'AUTOMATION_API_REPLAY_CONFLICT' });
});

test('automation API rejects accessor-backed page and receipt arrays without invoking element getters', async () => {
  let pageTrapped = false;
  const redactionPages = [1];
  Object.defineProperty(redactionPages, '0', { enumerable: true, configurable: true, get() { pageTrapped = true; throw new Error('page trap'); } });
  assert.throws(() => normalizeAutomationApiSubmitRequest(request({ operation: { kind: 'operation', id: 'automation_full_page_redaction_v1', pages: redactionPages } })), { code: 'INVALID_AUTOMATION_API_REQUEST' });
  assert.equal(pageTrapped, false);

  let receiptTrapped = false;
  const receiptItems = [{ durableOutput: null }];
  Object.defineProperty(receiptItems, '0', { enumerable: true, configurable: true, get() { receiptTrapped = true; throw new Error('receipt item trap'); } });
  const state = setup({ queueOverrides: { async get() { return job('completed', { items: receiptItems }); } } });
  await state.api.submit(request());
  await assert.rejects(state.api.status({ principal: 'caller.one', grant, jobId: 'job_1' }), { code: 'AUTOMATION_API_RESULT_INVALID' });
  assert.equal(receiptTrapped, false);
});

test('automation API closes a live source stream when source metadata is malformed', async () => {
  let destroyed = false;
  const state = setup({ sourceOverrides: {
    async openVerified() { return { id: 'wrong_source', sha256: sourceSha256, stream: { destroy() { destroyed = true; } } }; },
  } });
  await assert.rejects(state.api.submit(request()), { code: 'AUTOMATION_API_SOURCE_NOT_FOUND' });
  assert.equal(destroyed, true);
});

test('automation API rejects forged queue response identity and wrong operation type', async () => {
  const wrongType = setup({ queueOverrides: { async enqueue() { return { idempotent: false, job: job('pending') && { ...job(), type: 'automation_ocr_v1' } }; } } });
  await assert.rejects(wrongType.api.submit(request()), { code: 'AUTOMATION_API_RESULT_INVALID' });
  const unsafeId = setup({ queueOverrides: { async enqueue() { return { idempotent: false, job: { ...job(), id: 'job with spaces' } }; } } });
  await assert.rejects(unsafeId.api.submit(request()), { code: 'AUTOMATION_API_RESULT_INVALID' });
});

test('automation API rejects output metadata that drifts from the submitting source binding', async () => {
  const state = setup({
    queueOverrides: { async get() { return job('completed', { durableOutput: { id: 'output_1', sha256: outputSha256, size: 10 } }); } },
    outputMetadata: { id: 'output_1', sha256: outputSha256, size: 10, sourceId: 'other_source', sourceSha256: 'c'.repeat(64) },
  });
  await state.api.submit(request());
  await state.api.status({ principal: 'caller.one', grant, jobId: 'job_1' });
  await assert.rejects(state.api.output({ principal: 'caller.one', grant, jobId: 'job_1', outputId: 'output_1', outputSha256 }), { code: 'AUTOMATION_API_OUTPUT_NOT_FOUND' });
});

test('automation API rejects owned job identity drift before exposing status or cancelling', async () => {
  const state = setup({ queueOverrides: {
    async get() { return { ...job(), type: 'automation_ocr_v1' }; },
  } });
  await state.api.submit(request());
  await assert.rejects(state.api.status({ principal: 'caller.one', grant, jobId: 'job_1' }), { code: 'AUTOMATION_API_RESULT_INVALID' });
  await assert.rejects(state.api.poll({ principal: 'caller.one', grant, jobId: 'job_1', maxWaitMs: 0 }), { code: 'AUTOMATION_API_RESULT_INVALID' });
  await assert.rejects(state.api.cancel({ principal: 'caller.one', grant, jobId: 'job_1' }), { code: 'AUTOMATION_API_RESULT_INVALID' });
});

function assertInvalidReceipt(action, message) {
  assert.throws(action, (error) => error instanceof HostError
    && error.code === 'AUTOMATION_API_RESULT_INVALID'
    && error.message === message
    && error.status === 502);
}

test('automation API receipt sanitizer copies only plain permitted data and never reads stripped fields', () => {
  let forbiddenGetterCalls = 0;
  const symbol = Symbol('internal');
  const receipt = {
    durableOutput: { id: 'output_1', sha256: outputSha256, size: 10 },
    items: [{ page: 1 }],
    secret: 'strip me',
    [symbol]: 'strip me too',
  };
  Object.defineProperty(receipt, 'privateToken', {
    enumerable: true,
    get() { forbiddenGetterCalls += 1; throw new Error('must not run'); },
  });
  const copied = publicAutomationApiReceipt(receipt);
  assert.deepEqual(copied, {
    durableOutput: { id: 'output_1', sha256: outputSha256, size: 10 },
    items: [{ page: 1 }],
  });
  assert.equal(forbiddenGetterCalls, 0);
  assert.equal(Object.getOwnPropertySymbols(copied).length, 0);
  assert.equal(Object.isFrozen(copied), true);
  assert.equal(Object.isFrozen(copied.items), true);
  assert.equal(Object.isFrozen(copied.items[0]), true);
  assert.notEqual(copied.items, receipt.items);
});

test('automation API receipt sanitizer distinguishes hostile result shapes with exact gateway errors', () => {
  let accessorCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'safe', {
    enumerable: true,
    get() { accessorCalls += 1; throw new Error('must not run'); },
  });
  assertInvalidReceipt(() => publicAutomationApiReceipt(new Proxy({}, {})), 'Automation API receipt is invalid.');
  assertInvalidReceipt(() => publicAutomationApiReceipt(accessor), 'Automation API receipt contains an accessor.');
  assert.equal(accessorCalls, 0);
  assertInvalidReceipt(() => publicAutomationApiReceipt(new Array(1)), 'Automation API receipt array must be dense data-only values.');
  assertInvalidReceipt(() => publicAutomationApiReceipt(Array.from({ length: 501 }, () => null)), 'Automation API receipt array is invalid.');
  const malformedOversize = new Array(501);
  malformedOversize.extra = true;
  assertInvalidReceipt(() => publicAutomationApiReceipt(malformedOversize), 'Automation API receipt array is invalid.');
  const cycle = {};
  cycle.self = cycle;
  assertInvalidReceipt(() => publicAutomationApiReceipt(cycle), 'Automation API receipt is invalid.');
  let deep = null;
  for (let index = 0; index < 10; index += 1) deep = { child: deep };
  assertInvalidReceipt(() => publicAutomationApiReceipt(deep), 'Automation API receipt is too deep.');
});

test('automation API request arrays reject sparse, symbolic, and oversized hostile page inputs', () => {
  const redaction = (pages) => request({ operation: { kind: 'operation', id: 'automation_full_page_redaction_v1', pages } });
  const invalid = (pages, message) => assertInvalidRequest(() => normalizeAutomationApiSubmitRequest(redaction(pages)), message);
  invalid([], 'Automation API redaction pages are invalid.');
  invalid(Array.from({ length: 101 }, (_, index) => index + 1), 'Automation API redaction pages are invalid.');
  invalid(new Array(1), 'Automation API redaction pages are invalid.');
  const symbolic = [1];
  symbolic[Symbol('internal')] = true;
  invalid(symbolic, 'Automation API redaction pages are invalid.');
  const extended = [1];
  extended.extra = true;
  invalid(extended, 'Automation API redaction pages are invalid.');
  const accessor = [1];
  Object.defineProperty(accessor, '0', { configurable: true, enumerable: true, get() { throw new Error('must not run'); } });
  invalid(accessor, 'Automation API redaction pages must be dense data-only values.');
  const balanced = new Array(1);
  balanced['00'] = 1;
  invalid(balanced, 'Automation API redaction pages must be dense data-only values.');
});

function assertInvalidRequest(action, message = null) {
  assert.throws(action, (error) => error instanceof HostError
    && error.code === 'INVALID_AUTOMATION_API_REQUEST'
    && error.status === 400
    && (message === null || error.message === message));
}

test('automation API validates primitive selection kinds before policy lookup or coercion', () => {
  let coercions = 0;
  const coercible = { [Symbol.toPrimitive]() { coercions += 1; return 'operation'; } };
  let proxyTraps = 0;
  const kindProxy = new Proxy({}, { get() { proxyTraps += 1; throw new Error('must not run'); } });
  const withKind = (kind) => request({ operation: { kind, id: AUTOMATION_INSPECT_TYPE, pages: null } });
  assertInvalidRequest(() => normalizeAutomationApiSubmitRequest(withKind(new String('operation'))));
  assertInvalidRequest(() => normalizeAutomationApiSubmitRequest(withKind(coercible)));
  assertInvalidRequest(() => normalizeAutomationApiSubmitRequest(withKind(kindProxy)));
  assert.equal(coercions, 0);
  assert.equal(proxyTraps, 0);
});

test('automation API rejects non-string regex scalars without coercion', () => {
  let coercions = 0;
  const hostile = { [Symbol.toPrimitive]() { coercions += 1; return source.id; } };
  const submit = (overrides) => normalizeAutomationApiSubmitRequest(request(overrides));
  assertInvalidRequest(() => submit({ principal: hostile }));
  assertInvalidRequest(() => submit({ grant: { ...grant, grantId: hostile } }));
  assertInvalidRequest(() => submit({ source: { id: hostile, sha256: sourceSha256 } }));
  assertInvalidRequest(() => submit({ source: { id: source.id, sha256: hostile } }));
  assertInvalidRequest(() => submit({ operation: { kind: 'operation', id: hostile, pages: null } }));
  assertInvalidRequest(() => normalizeAutomationApiStatusRequest({ principal: 'caller.one', grant, jobId: hostile }));
  assertInvalidRequest(() => normalizeAutomationApiOutputRequest({ principal: 'caller.one', grant, jobId: hostile, outputId: 'output_1', outputSha256 }));
  assertInvalidRequest(() => normalizeAutomationApiOutputRequest({ principal: 'caller.one', grant, jobId: 'job_1', outputId: hostile, outputSha256 }));
  assertInvalidRequest(() => normalizeAutomationApiOutputRequest({ principal: 'caller.one', grant, jobId: 'job_1', outputId: 'output_1', outputSha256: hostile }));
  assert.equal(coercions, 0);
});

test('automation API rejects revoked proxies before array or object reflection', () => {
  const revokedRequest = Proxy.revocable(request(), {});
  revokedRequest.revoke();
  assertInvalidRequest(() => normalizeAutomationApiSubmitRequest(revokedRequest.proxy));
  const revokedPages = Proxy.revocable([1], {});
  revokedPages.revoke();
  assertInvalidRequest(() => normalizeAutomationApiSubmitRequest(request({ operation: { kind: 'operation', id: 'automation_full_page_redaction_v1', pages: revokedPages.proxy } })));
  const revokedReceipt = Proxy.revocable({}, {});
  revokedReceipt.revoke();
  assertInvalidReceipt(() => publicAutomationApiReceipt(revokedReceipt.proxy), 'Automation API receipt is invalid.');
  const revokedReceiptArray = Proxy.revocable([1], {});
  revokedReceiptArray.revoke();
  assertInvalidReceipt(() => publicAutomationApiReceipt(revokedReceiptArray.proxy), 'Automation API receipt is invalid.');
});

test('automation API receipt copying omits prototype keys, retains location, and rejects array cycles', () => {
  const receipt = { location: 'local-review', safe: true };
  Object.defineProperty(receipt, '__proto__', { configurable: true, enumerable: true, value: { polluted: true }, writable: true });
  Object.defineProperty(receipt, 'constructor', { configurable: true, enumerable: true, value: 'drop', writable: true });
  Object.defineProperty(receipt, 'prototype', { configurable: true, enumerable: true, value: 'drop', writable: true });
  const copied = publicAutomationApiReceipt(receipt);
  assert.deepEqual(copied, { location: 'local-review', safe: true });
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(Object.hasOwn(copied, '__proto__'), false);
  const cycle = [];
  cycle.push(cycle);
  assertInvalidReceipt(() => publicAutomationApiReceipt(cycle), 'Automation API receipt is invalid.');
});

test('automation API receipt extended arrays retain the exact dense-data error', () => {
  const extended = [1];
  extended.extra = true;
  assertInvalidReceipt(() => publicAutomationApiReceipt(extended), 'Automation API receipt array must be dense data-only values.');
});
