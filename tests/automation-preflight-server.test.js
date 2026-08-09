import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreflightReport } from '../scripts/host/preflight-rules.mjs';
import { AutomationPreflightServerQueue } from '../scripts/host/automation/automation-preflight-server-queue.mjs';
import {
  AutomationPreflightServerService, automationPreflightServerJobId,
} from '../scripts/host/automation/automation-preflight-server-service.mjs';

const grant = Object.freeze({ grantId: 'grant_preflight_1', principal: 'caller.one' });
const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });

function request(overrides = {}) {
  return { principal: grant.principal, grant, source, profile: 'print-review',
    idempotencyKey: 'preflight-1', ...overrides };
}

function report(profile = 'print-review', sha256 = source.sha256) {
  return buildPreflightReport({
    profile, document: { sha256 },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no', pdfVersion: '1.7' },
    structure: { sourceDigest: source.sha256, pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{ page: 1, widthPoints: 612, heightPoints: 792,
        boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 } } }],
      xmpMetadata: { present: true } },
    fonts: [{ name: 'Embedded', embedded: 'yes', unicode: 'yes', sourceSha256: source.sha256 }], images: [],
  });
}

function setup({ open = null, run = null, authorize = null, queue = undefined } = {}) {
  const calls = { open: [], destroy: [], run: [], authority: [] };
  const sources = { async openVerified(id, sha256) {
    calls.open.push({ id, sha256 });
    if (open) return open(id, sha256, calls);
    return { id, sha256, size: 100, stream: { destroy() { calls.destroy.push(id); } } };
  } };
  const engine = run === false ? undefined : { async run(value) { calls.run.push(value);
    return run ? run(value, calls) : report(value.profile, value.source.sha256); } };
  const authority = { async authorize(value, context) { calls.authority.push({ value, context });
    if (authorize) return authorize(value, context, calls); } };
  return { service: new AutomationPreflightServerService({ sources, authority, engine, queue }), calls };
}

test('preflight server runs fixed local evidence and returns only a safe digest-bound receipt', async () => {
  const state = setup();
  const value = request();
  const receipt = await state.service.submit(value);
  assert.equal(receipt.jobId, automationPreflightServerJobId(value));
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.profile, 'print-review');
  assert.equal(receipt.result.source.sha256, source.sha256);
  assert.match(receipt.result.reportSha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.result.localOnly, true); assert.equal(receipt.result.authoritative, false);
  assert.equal(Object.hasOwn(receipt.result, 'checks'), false);
  assert.equal(Object.hasOwn(receipt.result.source, 'size'), false);
  assert.equal(JSON.stringify(receipt).includes('path'), false);
  assert.deepEqual(state.calls.destroy, ['source_1']);
  assert.equal(state.calls.authority[0].context.capability, 'automation.preflight-server');
  await state.service.close();
});

test('default engine is unavailable and still closes the verified source', async () => {
  const state = setup({ run: false });
  await assert.rejects(state.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_UNAVAILABLE', status: 503 });
  assert.deepEqual(state.calls.destroy, ['source_1']);
  await state.service.close();
});

test('request rejects custom profiles, extra fields, proxies, and accessors before authority or source access', async () => {
  const state = setup();
  assert.throws(() => state.service.submit(request({ profile: 'PDF/X-4' })), { code: 'INVALID_AUTOMATION_PREFLIGHT_SERVER' });
  assert.throws(() => state.service.submit({ ...request(), url: 'http://127.0.0.1' }), { code: 'INVALID_AUTOMATION_PREFLIGHT_SERVER' });
  assert.throws(() => state.service.submit(new Proxy(request(), {})), { code: 'INVALID_AUTOMATION_PREFLIGHT_SERVER' });
  const accessor = request();
  Object.defineProperty(accessor, 'source', { enumerable: true, get() { throw new Error('trap'); } });
  assert.throws(() => state.service.submit(accessor), { code: 'INVALID_AUTOMATION_PREFLIGHT_SERVER' });
  assert.equal(state.calls.authority.length, 0); assert.equal(state.calls.open.length, 0);
  await state.service.close();
});

test('authority denial precedes source and engine access', async () => {
  const state = setup({ authorize: () => { throw new Error('denied'); } });
  await assert.rejects(state.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_CAPABILITY_DENIED', status: 403 });
  assert.equal(state.calls.open.length, 0); assert.equal(state.calls.run.length, 0);
  await state.service.close();
});

test('source drift and forged engine evidence fail closed with stream cleanup', async () => {
  const drift = setup({ open: (_id, sha256, calls) => ({ id: 'source_2', sha256, size: 100,
    stream: { destroy() { calls.destroy.push('drift'); } } }) });
  await assert.rejects(drift.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', status: 409 });
  assert.equal(drift.calls.run.length, 0); assert.deepEqual(drift.calls.destroy, ['drift']);
  const forged = setup({ run: () => report('print-review', 'b'.repeat(64)) });
  await assert.rejects(forged.service.submit(request()), { code: 'INVALID_PREFLIGHT_INPUT', status: 400 });
  assert.deepEqual(forged.calls.destroy, ['source_1']);
  const malformed = setup({ run: () => ({ kind: 'preflight-review' }) });
  await assert.rejects(malformed.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_RESULT_INVALID', status: 502 });
  await drift.service.close(); await forged.service.close(); await malformed.service.close();
});

test('rejected source descriptors and nested stream proxies never invoke hostile traps or getters', async () => {
  let streamGetter = 0; let destroyGetter = 0; let proxyTraps = 0; let sourceProxyTraps = 0;
  const accessor = setup({ open: (id, sha256) => {
    const opened = { id, sha256, size: 100 };
    Object.defineProperty(opened, 'stream', { enumerable: true, get() { streamGetter += 1; throw new Error('trap'); } });
    return opened;
  } });
  await assert.rejects(accessor.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT' });
  const nestedAccessor = setup({ open: (id, sha256) => {
    const stream = {};
    Object.defineProperty(stream, 'destroy', { enumerable: true, get() { destroyGetter += 1; throw new Error('trap'); } });
    return { id, sha256, size: 100, stream };
  } });
  await assert.rejects(nestedAccessor.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT' });
  const nestedProxy = setup({ open: (id, sha256) => ({ id, sha256, size: 100,
    stream: new Proxy({}, { get() { proxyTraps += 1; }, getPrototypeOf() { proxyTraps += 1; return Object.prototype; }, ownKeys() { proxyTraps += 1; return []; } }) }) });
  await assert.rejects(nestedProxy.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT' });
  const sourceProxy = setup({ open: (id, sha256) => new Proxy({ id, sha256, size: 100, stream: { destroy() {} } }, {
    get(target, key, receiver) { if (key !== 'then') sourceProxyTraps += 1; return Reflect.get(target, key, receiver); },
    getPrototypeOf() { sourceProxyTraps += 1; return Object.prototype; }, ownKeys() { sourceProxyTraps += 1; return []; },
  }) });
  await assert.rejects(sourceProxy.service.submit(request()), { code: 'AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT' });
  assert.deepEqual({ streamGetter, destroyGetter, proxyTraps, sourceProxyTraps },
    { streamGetter: 0, destroyGetter: 0, proxyTraps: 0, sourceProxyTraps: 0 });
  assert.equal(accessor.calls.run.length + nestedAccessor.calls.run.length + nestedProxy.calls.run.length + sourceProxy.calls.run.length, 0);
  await accessor.service.close(); await nestedAccessor.service.close(); await nestedProxy.service.close(); await sourceProxy.service.close();
});

test('idempotent replay shares execution and conflicting reuse fails synchronously', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ run: async (value) => { await gate; return report(value.profile, value.source.sha256); } });
  const first = state.service.submit(request());
  const second = state.service.submit(request());
  assert.strictEqual(first, second);
  assert.throws(() => state.service.submit(request({ profile: 'archive-review' })), { code: 'AUTOMATION_PREFLIGHT_SERVER_REPLAY_CONFLICT' });
  release();
  assert.strictEqual(await first, await second);
  assert.equal(state.calls.run.length, 1);
  await state.service.close();
});

test('queue enforces concurrency and bounded pending admission', async () => {
  let active = 0; let maximumActive = 0; let entered = 0; let notify;
  const twoEntered = new Promise((resolve) => { notify = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new AutomationPreflightServerQueue({ concurrency: 2, maximumQueued: 1 });
  const state = setup({ queue, run: async (value) => {
    active += 1; entered += 1; maximumActive = Math.max(maximumActive, active);
    if (entered === 2) notify();
    await gate; active -= 1; return report(value.profile, value.source.sha256);
  } });
  const jobs = [1, 2, 3].map((index) => state.service.submit(request({ source: { id: `source_${index}`, sha256: source.sha256 }, idempotencyKey: `job-${index}` })));
  await twoEntered;
  const rejected = state.service.submit(request({ source: { id: 'source_4', sha256: source.sha256 }, idempotencyKey: 'job-4' }));
  await assert.rejects(rejected, { code: 'AUTOMATION_PREFLIGHT_SERVER_QUEUE_FULL', status: 429 });
  assert.equal(state.calls.run.length, 2); assert.equal(maximumActive, 2);
  release(); await Promise.all(jobs);
  await state.service.close();
});

test('queue-full admission is evicted and the same request succeeds after the queue drains', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const queue = new AutomationPreflightServerQueue({ concurrency: 1, maximumQueued: 1 });
  let calls = 0;
  const state = setup({ queue, run: async (value) => {
    calls += 1; if (calls === 1) { entered(); await gate; }
    return report(value.profile, value.source.sha256);
  } });
  const first = state.service.submit(request({ idempotencyKey: 'hold-1' }));
  await started;
  const second = state.service.submit(request({ source: { id: 'source_2', sha256: source.sha256 }, idempotencyKey: 'hold-2' }));
  const retryable = request({ source: { id: 'source_3', sha256: source.sha256 }, idempotencyKey: 'retry-full' });
  await assert.rejects(state.service.submit(retryable), { code: 'AUTOMATION_PREFLIGHT_SERVER_QUEUE_FULL' });
  release(); await first; await second;
  assert.equal((await state.service.submit(retryable)).status, 'completed');
  await state.service.close();
});

test('denied admissions do not consume capacity and oldest terminal records make room after 64 jobs', async () => {
  let deny = true;
  const state = setup({ authorize: () => { if (deny) throw new Error('denied'); } });
  for (let index = 0; index < 70; index += 1) {
    await assert.rejects(state.service.submit(request({ idempotencyKey: `denied-${index}` })), { code: 'AUTOMATION_PREFLIGHT_SERVER_CAPABILITY_DENIED' });
  }
  deny = false;
  let recentRequest; let recentReceipt;
  for (let index = 0; index < 65; index += 1) {
    recentRequest = request({ idempotencyKey: `completed-${index}` });
    recentReceipt = await state.service.submit(recentRequest);
  }
  const runs = state.calls.run.length;
  assert.strictEqual(await state.service.submit(recentRequest), recentReceipt);
  assert.equal(state.calls.run.length, runs);
  await state.service.close();
});

test('cancellation aborts a running engine and close cleans queued work', async () => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const state = setup({ run: async (value) => { started(); await new Promise((resolve) => {
    if (value.signal.aborted) resolve(); else value.signal.addEventListener('abort', resolve, { once: true });
  }); return report(value.profile, value.source.sha256); } });
  const value = request();
  const execution = state.service.submit(value);
  await entered;
  const cancelled = await state.service.cancel({ principal: grant.principal, grant,
    jobId: automationPreflightServerJobId(value) });
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(execution, { code: 'AUTOMATION_PREFLIGHT_SERVER_CANCELLED', status: 499 });
  assert.deepEqual(state.calls.destroy, ['source_1']);
  await state.service.close();
});

test('completed cancellation is an authorized no-op and replay retains the terminal receipt', async () => {
  const state = setup();
  const value = request();
  const completed = await state.service.submit(value);
  const signal = state.calls.run[0].signal;
  const result = await state.service.cancel({ principal: grant.principal, grant,
    jobId: automationPreflightServerJobId(value) });
  assert.deepEqual(result, { schemaVersion: 1, jobId: completed.jobId,
    cancelled: false, status: 'completed' });
  assert.equal(signal.aborted, false);
  assert.strictEqual(await state.service.submit(value), completed);
  assert.equal(state.calls.run.length, 1);
  await state.service.close();
  assert.equal(signal.aborted, false);
});

test('failed cancellation is an authorized no-op and replay retains the terminal failure', async () => {
  const failure = Object.assign(new Error('engine failed'), { code: 'ENGINE_FAILED' });
  const state = setup({ run: async () => { throw failure; } });
  const value = request();
  const execution = state.service.submit(value);
  await assert.rejects(execution, (error) => error === failure);
  const signal = state.calls.run[0].signal;
  const result = await state.service.cancel({ principal: grant.principal, grant,
    jobId: automationPreflightServerJobId(value) });
  assert.deepEqual(result, { schemaVersion: 1, jobId: automationPreflightServerJobId(value),
    cancelled: false, status: 'failed' });
  assert.equal(signal.aborted, false);
  assert.strictEqual(state.service.submit(value), execution);
  await assert.rejects(state.service.submit(value), (error) => error === failure);
  assert.equal(state.calls.run.length, 1);
  await state.service.close();
  assert.equal(signal.aborted, false);
});
