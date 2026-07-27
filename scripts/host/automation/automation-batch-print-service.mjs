import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_BATCH_PRINT_MAX_EXECUTIONS,
  AUTOMATION_BATCH_PRINT_MAX_SOURCE_BYTES,
  AUTOMATION_BATCH_PRINT_MAX_TOTAL_BYTES,
  batchPrintFail,
  normalizeAutomationBatchPrintCancelRequest,
  normalizeAutomationBatchPrintRequest,
} from './automation-batch-print-contract.mjs';
import {
  createAutomationBatchPrintPlan,
  UnavailableLocalPrintAdapter,
  UnavailableLocalPrinterInventory,
} from './automation-batch-print-planner.mjs';

function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify({ grant: request.grant, printerId: request.printerId,
    documents: request.documents, options: request.options, batchId: request.batchId }), 'utf8').digest('hex');
}

function admissionId(request) {
  return `bp_${createHash('sha256').update(JSON.stringify({ principal: request.principal, idempotencyKey: request.idempotencyKey,
    fingerprint: fingerprint(request) }), 'utf8').digest('hex').slice(0, 32)}`;
}

export function automationBatchPrintAdmissionId(value) {
  return admissionId(normalizeAutomationBatchPrintRequest(value));
}

function snapshotAdapterResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) batchPrintFail('AUTOMATION_BATCH_PRINT_ADAPTER_INVALID', 'Local print adapter response is invalid.', 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(descriptors, 'adapterJobId') || !Object.hasOwn(descriptors, 'status')
    || Reflect.ownKeys(value).some((key) => !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || typeof descriptors.adapterJobId.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(descriptors.adapterJobId.value)) batchPrintFail('AUTOMATION_BATCH_PRINT_ADAPTER_INVALID', 'Local print adapter response identity is invalid.', 502);
  return Object.freeze({ adapterJobId: descriptors.adapterJobId.value, status: descriptors.status.value });
}

function checkedAdapterStatus(snapshot) {
  if (!['accepted', 'completed'].includes(snapshot.status)) batchPrintFail('AUTOMATION_BATCH_PRINT_ADAPTER_INVALID', 'Local print adapter status is invalid.', 502);
  return snapshot.status;
}

function authorityDenied(error) {
  if (error instanceof HostError && error.code === 'AUTOMATION_BATCH_PRINT_CAPABILITY_DENIED') throw error;
  throw new HostError('AUTOMATION_BATCH_PRINT_CAPABILITY_DENIED', 'Batch print capability was denied.', 403, { cause: error });
}

export class AutomationBatchPrintService {
  #sources; #inventory; #adapter; #authority; #executions = new Map(); #admission = Promise.resolve(); #closed = false; #closeOperation = null;

  constructor({ sources, authority, printerInventory = new UnavailableLocalPrinterInventory(), adapter = new UnavailableLocalPrintAdapter() } = {}) {
    if (typeof sources?.openVerified !== 'function' || typeof authority?.authorize !== 'function'
      || typeof printerInventory?.resolve !== 'function' || typeof adapter?.admit !== 'function' || typeof adapter?.cancel !== 'function') {
      throw new TypeError('Batch print requires source storage, authority, trusted printer inventory, and local print adapter.');
    }
    this.#sources = sources; this.#authority = authority; this.#inventory = printerInventory; this.#adapter = adapter;
  }

  async #authorize(request, action, plan = null) {
    try {
      const result = await this.#authority.authorize(request.grant, Object.freeze({
        principal: request.principal, capability: 'automation.batch-print', action: `batch-print.${action}`,
        admissionId: request.admissionId ?? null, batchId: request.batchId ?? null,
        printer: plan ? Object.freeze({ ...plan.printer }) : request.printerId ? Object.freeze({ id: request.printerId }) : null,
        documents: request.documents ? Object.freeze(request.documents.map((item) => Object.freeze({ source: Object.freeze({ ...item.source }), copies: item.copies, pages: item.pages }))) : null,
        options: request.options ? Object.freeze({ ...request.options }) : null,
      }));
      if (result === false) throw new HostError('AUTOMATION_BATCH_PRINT_CAPABILITY_DENIED', 'denied', 403);
    } catch (error) { authorityDenied(error); }
  }

  submit(value, { signal = null } = {}) {
    if (this.#closed) batchPrintFail('AUTOMATION_BATCH_PRINT_CLOSED', 'Batch print service is closed.', 409);
    const request = normalizeAutomationBatchPrintRequest(value);
    const key = `${request.principal}\u0000${request.idempotencyKey}`;
    const requestFingerprint = fingerprint(request);
    const prior = this.#executions.get(key);
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) batchPrintFail('AUTOMATION_BATCH_PRINT_REPLAY_CONFLICT', 'Batch print idempotency key belongs to another request.', 409);
      return prior.promise;
    }
    if (this.#executions.size >= AUTOMATION_BATCH_PRINT_MAX_EXECUTIONS) batchPrintFail('AUTOMATION_BATCH_PRINT_EXECUTION_LIMIT', 'Batch print execution limit has been reached.', 429);
    const controller = new AbortController();
    const id = admissionId(request);
    const record = { admissionId: id, principal: request.principal, grant: request.grant, request, fingerprint: requestFingerprint,
      controller, plan: null, adapterJobId: null, cancellationState: 'idle', cancellationPromise: null, promise: null };
    const onAbort = () => controller.abort();
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    const run = this.#admission.then(() => this.#run(Object.freeze({ ...request, admissionId: id }), record));
    this.#admission = run.catch(() => {});
    record.promise = run.finally(() => signal?.removeEventListener?.('abort', onAbort));
    this.#executions.set(key, record);
    return record.promise;
  }

  async #run(request, record) {
    const signal = record.controller.signal;
    await this.#authorize(request, 'submit');
    if (signal.aborted) throw new HostError('AUTOMATION_BATCH_PRINT_CANCELLED', 'Batch print was cancelled.', 499);
    const printer = await this.#inventory.resolve(request.printerId);
    const plan = createAutomationBatchPrintPlan(request, printer);
    record.plan = plan;
    await this.#authorize(request, 'admit', plan);
    const opened = [];
    let totalBytes = 0;
    let primary = null;
    let receipt = null;
    try {
      for (const item of request.documents) {
        if (signal.aborted) throw new HostError('AUTOMATION_BATCH_PRINT_CANCELLED', 'Batch print was cancelled.', 499);
        const source = await this.#sources.openVerified(item.source.id, item.source.sha256);
        if (!source || source.id !== item.source.id || source.sha256 !== item.source.sha256
          || !Number.isSafeInteger(source.size) || source.size < 5
          || typeof source.stream?.destroy !== 'function') {
          source?.stream?.destroy?.();
          throw new HostError('AUTOMATION_BATCH_PRINT_SOURCE_DRIFT', 'Batch print source binding changed.', 409);
        }
        opened.push({ source: item.source, size: source.size, stream: source.stream });
        if (source.size > AUTOMATION_BATCH_PRINT_MAX_SOURCE_BYTES) {
          throw new HostError('AUTOMATION_BATCH_PRINT_SOURCE_LIMIT', 'Batch print source exceeds the per-document byte bound.', 413);
        }
        if (totalBytes > AUTOMATION_BATCH_PRINT_MAX_TOTAL_BYTES - source.size) {
          throw new HostError('AUTOMATION_BATCH_PRINT_SOURCE_LIMIT', 'Batch print sources exceed the aggregate byte bound.', 413);
        }
        totalBytes += source.size;
      }
      const result = snapshotAdapterResult(await this.#adapter.admit(Object.freeze({ admissionId: request.admissionId, plan,
        documents: Object.freeze(opened.map((item) => Object.freeze({ source: Object.freeze({ ...item.source }), size: item.size, stream: item.stream }))), signal })));
      record.adapterJobId = result.adapterJobId;
      const status = checkedAdapterStatus(result);
      if (signal.aborted) throw new HostError('AUTOMATION_BATCH_PRINT_CANCELLED', 'Batch print was cancelled.', 499);
      receipt = Object.freeze({ schemaVersion: 1, admissionId: request.admissionId, batchId: request.batchId,
        printer: plan.printer, planDigest: plan.planDigest, documentCount: plan.documents.length,
        status, localOnly: true });
    } catch (error) { primary = error; }
    const failures = primary ? [primary] : [];
    for (const item of opened) {
      try { item.stream.destroy(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      try { await this.#cancelRecord(record); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Batch print and cleanup failed.');
    }
    return receipt;
  }

  #cancelRecord(record) {
    if (!record.adapterJobId || record.cancellationState === 'succeeded') return Promise.resolve();
    if (record.cancellationState === 'in-flight') return record.cancellationPromise;
    record.cancellationState = 'in-flight';
    const cancellation = Object.freeze({ admissionId: record.admissionId, adapterJobId: record.adapterJobId,
      printer: record.plan.printer, planDigest: record.plan.planDigest });
    const run = Promise.resolve().then(() => this.#adapter.cancel(cancellation)).then(() => {
      record.cancellationState = 'succeeded';
    }, (error) => {
      record.cancellationState = 'idle';
      throw error;
    }).finally(() => {
      if (record.cancellationPromise === run) record.cancellationPromise = null;
    });
    record.cancellationPromise = run;
    return run;
  }

  async cancel(value) {
    const request = normalizeAutomationBatchPrintCancelRequest(value);
    await this.#authorize(request, 'cancel');
    const record = [...this.#executions.values()].find((item) => item.admissionId === request.admissionId
      && item.principal === request.principal && item.grant.grantId === request.grant.grantId);
    if (!record) batchPrintFail('AUTOMATION_BATCH_PRINT_NOT_FOUND', 'Batch print admission was not found.', 404);
    await this.#authorize({ ...record.request, admissionId: record.admissionId }, 'cancel', record.plan);
    record.controller.abort();
    const run = this.#admission.then(() => this.#cancelRecord(record));
    this.#admission = run.catch(() => {});
    await run;
    return Object.freeze({ schemaVersion: 1, admissionId: request.admissionId, cancelled: true });
  }

  async close() {
    this.#closed = true;
    if (this.#closeOperation) return this.#closeOperation;
    const run = (async () => {
      const records = [...this.#executions.values()];
      for (const record of records) record.controller.abort();
      await this.#admission;
      const results = await Promise.allSettled(records.map((record) => this.#cancelRecord(record)));
      const failures = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Batch print close failed.');
    })();
    this.#closeOperation = run;
    try { await run; } finally { if (this.#closeOperation === run) this.#closeOperation = null; }
  }
}
