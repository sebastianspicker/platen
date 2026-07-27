import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { serializePreflightReportXml } from '../preflight-rules.mjs';
import { MAX_PAGE_COUNT } from '../pdf-service-limits.mjs';
import {
  AUTOMATION_PREFLIGHT_SERVER_MAX_JOBS, AUTOMATION_PREFLIGHT_SERVER_MAX_SOURCE_BYTES,
  normalizeAutomationPreflightServerCancelRequest, normalizeAutomationPreflightServerRequest,
  preflightServerFail,
} from './automation-preflight-server-contract.mjs';
import { AutomationPreflightServerQueue } from './automation-preflight-server-queue.mjs';

function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify({ grant: request.grant, source: request.source,
    profile: request.profile }), 'utf8').digest('hex');
}

function jobId(request, requestFingerprint) {
  return `pf_${createHash('sha256').update(JSON.stringify({ principal: request.principal,
    idempotencyKey: request.idempotencyKey, fingerprint: requestFingerprint }), 'utf8').digest('hex').slice(0, 32)}`;
}

export function automationPreflightServerJobId(value) {
  const request = normalizeAutomationPreflightServerRequest(value);
  return jobId(request, fingerprint(request));
}

function destroySnapshot(stream) {
  if ((!stream || (typeof stream !== 'object' && typeof stream !== 'function')) || nodeTypes.isProxy(stream)) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
  let current = stream;
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (nodeTypes.isProxy(current)) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
    const descriptor = Object.getOwnPropertyDescriptor(current, 'destroy');
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
      return Object.freeze({ callable: descriptor.value, receiver: stream });
    }
    current = Object.getPrototypeOf(current);
  }
  preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
}

function sourceSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 4 || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !['id', 'sha256', 'size', 'stream'].includes(key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
  const cleanup = destroySnapshot(descriptors.stream.value);
  return Object.freeze({ id: descriptors.id.value, sha256: descriptors.sha256.value,
    size: descriptors.size.value, stream: descriptors.stream.value, cleanup });
}

function sourceBinding(snapshot, expected) {
  if (snapshot.id !== expected.id || snapshot.sha256 !== expected.sha256 || !Number.isSafeInteger(snapshot.size)
    || snapshot.size < 5 || snapshot.size > AUTOMATION_PREFLIGHT_SERVER_MAX_SOURCE_BYTES) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_SOURCE_DRIFT', 'Preflight source binding changed.', 409);
  return snapshot;
}

function safeReport(report, source, profile) {
  try { serializePreflightReportXml(report); } catch (error) {
    preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_RESULT_INVALID', 'Preflight engine result is invalid.', 502, error);
  }
  if (report.profile.id !== profile || report.document.sha256 !== source.sha256
    || report.document.pageCount > MAX_PAGE_COUNT) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_RESULT_INVALID', 'Preflight result source or profile binding is invalid.', 502);
  return Object.freeze({ profile, source: Object.freeze({ id: source.id, sha256: source.sha256 }),
    status: report.status, pageCount: report.document.pageCount, reportSha256: report.reportSha256,
    counts: Object.freeze({ pass: report.counts.pass, warning: report.counts.warning,
      fail: report.counts.fail, notChecked: report.counts['not-checked'] }), localOnly: true, authoritative: false });
}

function denied(error) {
  if (error instanceof HostError && error.code === 'AUTOMATION_PREFLIGHT_SERVER_CAPABILITY_DENIED') throw error;
  throw new HostError('AUTOMATION_PREFLIGHT_SERVER_CAPABILITY_DENIED', 'Preflight server capability was denied.', 403, { cause: error });
}

export class UnavailableAutomationPreflightEngine {
  async run() { throw new HostError('AUTOMATION_PREFLIGHT_SERVER_UNAVAILABLE', 'No trusted local preflight engine is configured.', 503); }
}

export class AutomationPreflightServerService {
  #sources; #authority; #engine; #queue; #records = new Map(); #closed = false; #closeOperation = null;

  constructor({ sources, authority, engine = new UnavailableAutomationPreflightEngine(),
    queue = new AutomationPreflightServerQueue() } = {}) {
    if (typeof sources?.openVerified !== 'function' || typeof authority?.authorize !== 'function'
      || typeof engine?.run !== 'function' || typeof queue?.enqueue !== 'function'
      || typeof queue?.cancel !== 'function' || typeof queue?.close !== 'function') throw new TypeError('Preflight server requires sources, authority, queue, and a trusted preflight engine.');
    this.#sources = sources; this.#authority = authority; this.#engine = engine; this.#queue = queue;
  }

  async #authorize(record, action) {
    try {
      const result = await this.#authority.authorize(record.grant, Object.freeze({ principal: record.principal,
        capability: 'automation.preflight-server', action: `preflight-server.${action}`, jobId: record.jobId,
        source: record.request?.source ?? null, profile: record.request?.profile ?? null }));
      if (result === false) throw new HostError('AUTOMATION_PREFLIGHT_SERVER_CAPABILITY_DENIED', 'denied', 403);
    } catch (error) { denied(error); }
  }

  submit(value) {
    if (this.#closed) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_CLOSED', 'Preflight server is closed.', 409);
    const request = normalizeAutomationPreflightServerRequest(value);
    const key = `${request.principal}\u0000${request.idempotencyKey}`;
    const requestFingerprint = fingerprint(request);
    const prior = this.#records.get(key);
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_REPLAY_CONFLICT', 'Preflight idempotency key belongs to another request.', 409);
      return prior.promise;
    }
    if (this.#records.size >= AUTOMATION_PREFLIGHT_SERVER_MAX_JOBS) {
      const terminal = [...this.#records.entries()].find(([, record]) => ['completed', 'failed', 'cancelled'].includes(record.state));
      if (terminal) this.#records.delete(terminal[0]);
    }
    if (this.#records.size >= AUTOMATION_PREFLIGHT_SERVER_MAX_JOBS) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_JOB_LIMIT', 'Preflight server job limit has been reached.', 429);
    const record = { jobId: jobId(request, requestFingerprint), principal: request.principal, grant: request.grant,
      key, request, fingerprint: requestFingerprint, controller: new AbortController(), admitted: false,
      state: 'admitting', receipt: null, promise: null };
    const run = this.#authorize(record, 'submit').then(() => {
      const execution = this.#queue.enqueue(record.jobId, record.controller, (signal) => this.#run(record, signal));
      record.admitted = true; record.state = 'queued'; return execution;
    }).then((receipt) => {
      record.state = 'completed'; record.receipt = receipt; return receipt;
    }, (error) => {
      if (!record.admitted && this.#records.get(key) === record) this.#records.delete(key);
      else record.state = error?.code === 'AUTOMATION_PREFLIGHT_SERVER_CANCELLED' ? 'cancelled' : 'failed';
      throw error;
    });
    record.promise = run; this.#records.set(key, record); return run;
  }

  async #run(record, signal) {
    record.state = 'running';
    if (signal.aborted) throw new HostError('AUTOMATION_PREFLIGHT_SERVER_CANCELLED', 'Preflight server job was cancelled.', 499);
    let cleanup = null;
    try {
      const opened = await this.#sources.openVerified(record.request.source.id, record.request.source.sha256);
      const snapshot = sourceSnapshot(opened);
      cleanup = snapshot.cleanup;
      const source = sourceBinding(snapshot, record.request.source);
      const report = await this.#engine.run(Object.freeze({ jobId: record.jobId, profile: record.request.profile,
        source: Object.freeze({ id: source.id, sha256: source.sha256, size: source.size }), stream: source.stream, signal }));
      if (signal.aborted) throw new HostError('AUTOMATION_PREFLIGHT_SERVER_CANCELLED', 'Preflight server job was cancelled.', 499);
      const result = safeReport(report, source, record.request.profile);
      return Object.freeze({ schemaVersion: 1, jobId: record.jobId, status: 'completed', result });
    } finally { if (cleanup) Reflect.apply(cleanup.callable, cleanup.receiver, []); }
  }

  async cancel(value) {
    const action = normalizeAutomationPreflightServerCancelRequest(value);
    const record = [...this.#records.values()].find((item) => item.jobId === action.jobId
      && item.principal === action.principal && item.grant.grantId === action.grant.grantId);
    if (!record) preflightServerFail('AUTOMATION_PREFLIGHT_SERVER_NOT_FOUND', 'Preflight server job was not found.', 404);
    await this.#authorize(record, 'cancel');
    if (['completed', 'failed'].includes(record.state)) return Object.freeze({ schemaVersion: 1,
      jobId: record.jobId, cancelled: false, status: record.state });
    record.controller.abort(); this.#queue.cancel(record.jobId);
    return Object.freeze({ schemaVersion: 1, jobId: record.jobId, cancelled: true, status: 'cancelled' });
  }

  async close() {
    this.#closed = true;
    if (this.#closeOperation) return this.#closeOperation;
    for (const record of this.#records.values()) if (!['completed', 'failed'].includes(record.state)) record.controller.abort();
    const run = (async () => {
      await this.#queue.close();
      await Promise.allSettled([...this.#records.values()].map((record) => record.promise));
    })();
    this.#closeOperation = run;
    try { await run; } finally { if (this.#closeOperation === run) this.#closeOperation = null; }
  }
}
