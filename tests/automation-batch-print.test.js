import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutomationBatchPrintService,
  automationBatchPrintAdmissionId,
} from '../scripts/host/automation/automation-batch-print-service.mjs';

const grant = Object.freeze({ grantId: 'grant_local_1', principal: 'caller.one' });
const source = (id, digest) => Object.freeze({ id, sha256: digest.repeat(64) });
const printer = Object.freeze({ id: 'printer_1', identityDigest: 'f'.repeat(64), status: 'ready', capabilities: Object.freeze({
  colorModes: Object.freeze(['color', 'monochrome']), duplexModes: Object.freeze(['one-sided', 'long-edge']),
  media: Object.freeze(['a4', 'letter']), scaling: Object.freeze(['actual', 'fit']),
}) });

function request(overrides = {}) {
  return { principal: 'caller.one', grant, batchId: 'batch_1', printerId: 'printer_1', idempotencyKey: 'print-1',
    documents: [{ source: source('source_1', 'a'), copies: 2, pages: [1, 3] }, { source: source('source_2', 'b'), copies: 1, pages: null }],
    options: { collate: true, colorMode: 'color', duplex: 'long-edge', media: 'a4', scaling: 'fit' }, ...overrides };
}

function setup({ resolve = null, admit = null, cancel = null, open = null } = {}) {
  const calls = { authorize: [], resolve: [], admit: [], cancel: [], opened: [], destroyed: [] };
  const sources = { async openVerified(id, sha256) {
    calls.opened.push({ id, sha256 });
    if (open) return open(id, sha256, calls);
    return { id, sha256, size: 5, stream: { destroy() { calls.destroyed.push(id); } } };
  } };
  const inventory = { async resolve(id) { calls.resolve.push(id); return resolve ? resolve(id) : printer; } };
  const adapter = {
    async admit(value) { calls.admit.push(value); return admit ? admit(value, calls) : { adapterJobId: 'adapter_job_1', status: 'accepted' }; },
    async cancel(value) { calls.cancel.push(value); if (cancel) return cancel(value, calls); },
  };
  const authority = { async authorize(value, context) { calls.authorize.push({ value, context }); } };
  return { service: new AutomationBatchPrintService({ sources, authority, printerInventory: inventory, adapter }), calls };
}

test('batch print admits a finite trusted plan and returns a redacted deterministic receipt', async () => {
  const state = setup();
  const result = await state.service.submit(request());
  assert.equal(result.admissionId, automationBatchPrintAdmissionId(request()));
  assert.equal(result.documentCount, 2);
  assert.equal(result.printer.id, printer.id);
  assert.equal(Object.hasOwn(result, 'adapterJobId'), false);
  assert.deepEqual(state.calls.opened.map((item) => item.id), ['source_1', 'source_2']);
  assert.deepEqual(state.calls.destroyed, ['source_1', 'source_2']);
  assert.equal(state.calls.admit.length, 1);
  assert.equal(state.calls.authorize.at(-1).context.action, 'batch-print.admit');
  await state.service.close();
  assert.equal(state.calls.cancel.length, 1);
});

test('default printer inventory and adapter fail closed without source or printer mutation', async () => {
  let opened = 0;
  const service = new AutomationBatchPrintService({ sources: { async openVerified() { opened += 1; } }, authority: { async authorize() {} } });
  await assert.rejects(service.submit(request()), { code: 'AUTOMATION_BATCH_PRINT_PRINTER_UNAVAILABLE' });
  assert.equal(opened, 0);
  await service.close();
});

test('request and trusted-printer boundaries reject accessors, proxies, unsupported options, and identity drift', async () => {
  const state = setup();
  assert.throws(() => state.service.submit(new Proxy(request(), {})), { code: 'INVALID_AUTOMATION_BATCH_PRINT' });
  const accessor = request();
  Object.defineProperty(accessor, 'documents', { enumerable: true, get() { throw new Error('trap'); } });
  assert.throws(() => state.service.submit(accessor), { code: 'INVALID_AUTOMATION_BATCH_PRINT' });
  await assert.rejects(state.service.submit(request({ idempotencyKey: 'unsupported', options: { ...request().options, duplex: 'short-edge' } })), { code: 'AUTOMATION_BATCH_PRINT_OPTION_UNSUPPORTED' });
  const drift = setup({ resolve: () => ({ ...printer, id: 'printer_2' }) });
  await assert.rejects(drift.service.submit(request()), { code: 'AUTOMATION_BATCH_PRINT_PRINTER_INVALID' });
  assert.equal(state.calls.opened.length, 0); assert.equal(drift.calls.opened.length, 0);
  await state.service.close(); await drift.service.close();
});

test('concurrent replay shares one serialized admission and conflicting reuse fails closed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ admit: async () => { await gate; return { adapterJobId: 'adapter_job_1', status: 'accepted' }; } });
  const first = state.service.submit(request());
  const second = state.service.submit(request());
  assert.strictEqual(first, second);
  assert.throws(() => state.service.submit(request({ batchId: 'batch_2' })), { code: 'AUTOMATION_BATCH_PRINT_REPLAY_CONFLICT' });
  release();
  assert.strictEqual(await first, await second);
  assert.equal(state.calls.admit.length, 1);
  await state.service.close();
});

test('cancellation serializes behind in-flight admission, aborts it, and cancels the adapter job once', async () => {
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ admit: async () => { started(); await gate; return { adapterJobId: 'adapter_job_1', status: 'accepted' }; } });
  const value = request();
  const execution = state.service.submit(value);
  await entered;
  let cancelled = false;
  const cancellation = state.service.cancel({ principal: grant.principal, grant, admissionId: automationBatchPrintAdmissionId(value) }).then(() => { cancelled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, false);
  release();
  await assert.rejects(execution, { code: 'AUTOMATION_BATCH_PRINT_CANCELLED' });
  await cancellation;
  assert.equal(cancelled, true);
  assert.equal(state.calls.cancel.length, 1);
  await state.service.close();
  assert.equal(state.calls.cancel.length, 1);
});

test('source drift, forged adapter output, and cleanup failure revoke accepted admission safely', async () => {
  const drift = setup({ open: (id, sha256, calls) => id === 'source_1'
    ? { id, sha256, size: 5, stream: { destroy() { calls.destroyed.push(id); } } }
    : { id, sha256: 'c'.repeat(64), size: 5, stream: { destroy() { calls.destroyed.push(id); } } } });
  await assert.rejects(drift.service.submit(request()), { code: 'AUTOMATION_BATCH_PRINT_SOURCE_DRIFT' });
  assert.deepEqual(drift.calls.destroyed.sort(), ['source_1', 'source_2']);
  const forged = setup({ admit: async () => ({ adapterJobId: 'bad id', status: 'accepted' }) });
  await assert.rejects(forged.service.submit(request()), { code: 'AUTOMATION_BATCH_PRINT_ADAPTER_INVALID' });
  const invalidStatus = setup({ admit: async () => ({ adapterJobId: 'adapter_job_exact', status: 'unknown' }) });
  await assert.rejects(invalidStatus.service.submit(request()), { code: 'AUTOMATION_BATCH_PRINT_ADAPTER_INVALID' });
  assert.deepEqual(invalidStatus.calls.cancel.map((item) => item.adapterJobId), ['adapter_job_exact']);
  assert.equal(invalidStatus.calls.cancel[0].admissionId, automationBatchPrintAdmissionId(request()));
  assert.equal(invalidStatus.calls.cancel[0].printer.identityDigest, printer.identityDigest);
  assert.match(invalidStatus.calls.cancel[0].planDigest, /^[a-f0-9]{64}$/u);
  const cleanup = setup({ open: (id, sha256) => ({ id, sha256, size: 5, stream: { destroy() { if (id === 'source_1') throw Object.assign(new Error('destroy failed'), { code: 'DESTROY_FAILED' }); } } }) });
  await assert.rejects(cleanup.service.submit(request()), { code: 'DESTROY_FAILED' });
  assert.equal(cleanup.calls.cancel.length, 1);
  await drift.service.close(); await forged.service.close(); await invalidStatus.service.close(); await cleanup.service.close();
});

test('per-source and aggregate byte ceilings fail before adapter admission and close every opened stream', async () => {
  const oversized = setup({ open: (id, sha256, calls) => ({ id, sha256, size: Number.MAX_SAFE_INTEGER,
    stream: { destroy() { calls.destroyed.push(id); } } }) });
  await assert.rejects(oversized.service.submit(request()), { code: 'AUTOMATION_BATCH_PRINT_SOURCE_LIMIT', status: 413 });
  assert.equal(oversized.calls.admit.length, 0);
  assert.deepEqual(oversized.calls.destroyed, ['source_1']);

  const documents = [source('source_1', 'a'), source('source_2', 'b'), source('source_3', 'c')]
    .map((binding) => ({ source: binding, copies: 1, pages: null }));
  const aggregate = setup({ open: (id, sha256, calls) => ({ id, sha256, size: 400 * 1024 * 1024,
    stream: { destroy() { calls.destroyed.push(id); } } }) });
  await assert.rejects(aggregate.service.submit(request({ idempotencyKey: 'aggregate', documents })), { code: 'AUTOMATION_BATCH_PRINT_SOURCE_LIMIT', status: 413 });
  assert.equal(aggregate.calls.admit.length, 0);
  assert.deepEqual(aggregate.calls.destroyed, ['source_1', 'source_2', 'source_3']);
  await oversized.service.close(); await aggregate.service.close();
});

test('failed adapter cancellation remains retryable by close and succeeds without duplicate follow-up', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('transient cancel failure'), { code: 'CANCEL_TRANSIENT' });
  const state = setup({ cancel: async () => { attempts += 1; if (attempts === 1) throw failure; } });
  const value = request();
  await state.service.submit(value);
  await assert.rejects(state.service.cancel({ principal: grant.principal, grant, admissionId: automationBatchPrintAdmissionId(value) }), (error) => error === failure);
  assert.equal(attempts, 1);
  await state.service.close();
  assert.equal(attempts, 2);
  assert.equal(state.calls.cancel.length, 2);
});

test('serialized concurrent cancellation retries one failure and deduplicates the successful attempt', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('first cancel failed'), { code: 'CANCEL_TRANSIENT' });
  const state = setup({ cancel: async () => { attempts += 1; if (attempts === 1) throw failure; } });
  const value = request();
  await state.service.submit(value);
  const cancelRequest = { principal: grant.principal, grant, admissionId: automationBatchPrintAdmissionId(value) };
  const first = state.service.cancel(cancelRequest);
  const second = state.service.cancel(cancelRequest);
  await assert.rejects(first, (error) => error === failure);
  assert.equal((await second).cancelled, true);
  assert.equal(attempts, 2);
  await state.service.close();
  assert.equal(attempts, 2);
});

test('a failed close remains retryable and later close completes adapter cancellation', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('close cancel failed'), { code: 'CANCEL_TRANSIENT' });
  const state = setup({ cancel: async () => { attempts += 1; if (attempts === 1) throw failure; } });
  await state.service.submit(request());
  await assert.rejects(state.service.close(), (error) => error === failure);
  assert.equal(attempts, 1);
  await state.service.close();
  assert.equal(attempts, 2);
});
