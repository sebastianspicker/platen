import { types as nodeTypes } from 'node:util';
import { HostError, asHostError } from '../host-error.mjs';
import { AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE, AUTOMATION_INSPECT_PRESET, AUTOMATION_OCR_TYPE, AUTOMATION_OCR_PRESET, AUTOMATION_OUTPUT_INTENT_TYPE, AUTOMATION_OUTPUT_INTENT_PRESET, OPAQUE_ID, SHA256 } from './automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_TYPE } from './automation-sequence-contract.mjs';
import { sameSubmissionData, sourceTransaction } from './automation-api-submission.mjs';
import {
  apiFail,
  normalizeAutomationApiCancelRequest,
  normalizeAutomationApiOutputRequest,
  normalizeAutomationApiPollRequest,
  normalizeAutomationApiStatusRequest,
  normalizeAutomationApiSubmitRequest,
  publicAutomationApiReceipt,
  requiredCapability,
} from './automation-api-contract.mjs';

const QUEUE_ERROR_MAP = Object.freeze({
  IDEMPOTENCY_CONFLICT: ['AUTOMATION_API_REPLAY_CONFLICT', 409],
  QUEUE_FULL: ['AUTOMATION_API_QUEUE_FULL', 429],
  QUEUE_NOT_INITIALIZED: ['AUTOMATION_API_QUEUE_UNAVAILABLE', 503],
  QUEUE_JOB_NOT_FOUND: ['AUTOMATION_API_JOB_NOT_FOUND', 404],
  INVALID_QUEUE_JOB_ID: ['AUTOMATION_API_JOB_NOT_FOUND', 404],
  INVALID_IDEMPOTENCY_KEY: ['AUTOMATION_API_QUEUE_REQUEST_INVALID', 400],
  INVALID_QUEUE_JOB_TYPE: ['AUTOMATION_API_OPERATION_DENIED', 403],
  QUEUE_LEASE_CONFLICT: ['AUTOMATION_API_QUEUE_CONFLICT', 409],
});
const API_ERROR_CODES = new Set(['AUTOMATION_API_CAPABILITY_DENIED', 'AUTOMATION_API_RESOURCE_NOT_FOUND', 'AUTOMATION_API_RESULT_INVALID', 'AUTOMATION_API_REPLAY_CONFLICT', 'AUTOMATION_API_OPERATION_DENIED', 'AUTOMATION_API_GRANT_MISMATCH', 'AUTOMATION_API_SOURCE_NOT_FOUND', 'AUTOMATION_API_OUTPUT_NOT_FOUND', 'AUTOMATION_API_ADMISSION_UNCERTAIN', 'AUTOMATION_API_ADMISSION_CONFLICT', 'AUTOMATION_API_SOURCE_COMMIT_UNCERTAIN']);
const DURABLE_AUTOMATION_TYPES = new Set([
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_SEQUENCE_TYPE,
]);

function mappedError(error, fallbackCode = 'AUTOMATION_API_QUEUE_FAILURE', fallbackStatus = 503) {
  if (error instanceof HostError && API_ERROR_CODES.has(error.code)) return error;
  const mapped = QUEUE_ERROR_MAP[error?.code];
  if (mapped) return new HostError(mapped[0], mapped[0] === 'AUTOMATION_API_JOB_NOT_FOUND' ? 'Automation API job was not found.' : error.message, mapped[1], { cause: error });
  if (error instanceof HostError && /^AUTOMATION_(?:SOURCE|OUTPUT)_/u.test(error.code)) {
    return new HostError(
      error.code.includes('OUTPUT') ? 'AUTOMATION_API_OUTPUT_NOT_FOUND' : 'AUTOMATION_API_SOURCE_NOT_FOUND',
      error.code.includes('OUTPUT') ? 'Automation API output was not found.' : 'Automation API source was not found.',
      404,
      { cause: error },
    );
  }
  return new HostError(fallbackCode, 'The automation API queue could not complete the request.', fallbackStatus, { cause: error });
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HostError('AUTOMATION_API_RESULT_INVALID', `${label} is invalid.`, 502);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) {
    throw new HostError('AUTOMATION_API_RESULT_INVALID', `${label} contains an accessor.`, 502);
  }
  return value;
}

function publicJob(job) {
  plain(job, 'Automation API job');
  if (!OPAQUE_ID.test(job.id ?? '') || !DURABLE_AUTOMATION_TYPES.has(job.type)
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)
    || !Number.isSafeInteger(job.attempts) || !Number.isSafeInteger(job.maxAttempts)
    || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt)) {
    throw new HostError('AUTOMATION_API_RESULT_INVALID', 'Automation API job is invalid.', 502);
  }
  const retry = job.retry === null ? null : (() => {
    plain(job.retry, 'Automation API retry evidence');
    if (!['transient', 'interrupted'].includes(job.retry.classification)
      || !Number.isSafeInteger(job.retry.notBefore)) throw new HostError('AUTOMATION_API_RESULT_INVALID', 'Automation API retry evidence is invalid.', 502);
    return Object.freeze({ classification: job.retry.classification, notBefore: job.retry.notBefore });
  })();
  return Object.freeze({
    id: job.id, type: job.type, status: job.status, attempts: job.attempts,
    maxAttempts: job.maxAttempts, createdAt: job.createdAt, updatedAt: job.updatedAt,
    retry,
    receipt: job.receipt === null ? null : publicAutomationApiReceipt(job.receipt),
  });
}

function sourceBinding(opened, expected) {
  plain(opened, 'Automation API source');
  if (opened.id !== expected.id || opened.sha256 !== expected.sha256
    || !Number.isSafeInteger(opened.size) || opened.size < 5
    || !opened.stream || typeof opened.stream.destroy !== 'function') {
    throw new HostError('AUTOMATION_API_SOURCE_NOT_FOUND', 'Automation API source was not found.', 404);
  }
  return Object.freeze({ id: opened.id, sha256: opened.sha256, size: opened.size });
}

function operationType(operation) {
  if (operation?.kind === 'sequence') return AUTOMATION_SEQUENCE_TYPE;
  if (operation?.kind === 'preset') {
    if (operation.id === AUTOMATION_INSPECT_PRESET) return AUTOMATION_INSPECT_TYPE;
    if (operation.id === AUTOMATION_OCR_PRESET) return AUTOMATION_OCR_TYPE;
    if (operation.id === AUTOMATION_OUTPUT_INTENT_PRESET) return AUTOMATION_OUTPUT_INTENT_TYPE;
  }
  return operation?.id;
}

/**
 * In-process boundary over the local durable automation queue. It intentionally
 * accepts no scripts, paths, streams, or arbitrary operation payloads.
 */
export class AutomationApiService {
  #queue; #registry; #sources; #worker; #authority; #sleep; #clock;
  #jobOwners = new Map(); #idempotency = new Map(); #outputOwners = new Map();

  constructor({ queue, registry, sources, worker = null, authority, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = () => Date.now() } = {}) {
    if (!queue || typeof queue.enqueue !== 'function' || typeof queue.get !== 'function'
      || typeof queue.cancel !== 'function' || typeof queue.admission !== 'function' || !registry
      || typeof sources?.openVerified !== 'function' || typeof sources?.commit !== 'function'
      || typeof sources?.getOutputMetadata !== 'function'
      || (!worker && typeof queue.cancel !== 'function')
      || (!authority || typeof authority.authorize !== 'function')
      || typeof sleep !== 'function' || typeof clock !== 'function') {
      throw new TypeError('AutomationApiService requires queue, registry, sources, and a capability authority.');
    }
    this.#queue = queue;
    this.#registry = registry;
    this.#sources = sources;
    this.#worker = worker;
    this.#authority = authority;
    this.#sleep = sleep;
    this.#clock = clock;
  }

  async #authorize(request, action, operation = null) {
    const capability = requiredCapability(action);
    try {
      const context = {
        principal: request.principal,
        capability,
        action,
        operation,
        source: request.source ?? null,
        jobId: request.jobId ?? null,
        outputId: request.outputId ?? null,
      };
      if (action === 'submit' && this.#authority.requiresIdempotencyBinding === true) context.idempotencyKey = request.idempotencyKey;
      const result = await this.#authority.authorize(request.grant, Object.freeze(context));
      if (result === false) throw new HostError('AUTOMATION_API_CAPABILITY_DENIED', 'Automation API capability grant does not authorize this action.', 403);
    } catch (error) {
      if (error?.code === 'AUTOMATION_API_CAPABILITY_DENIED') throw error;
      throw new HostError('AUTOMATION_API_CAPABILITY_DENIED', 'Automation API capability grant does not authorize this action.', 403, { cause: error });
    }
  }

  #requestFingerprint(request) {
    return JSON.stringify({ source: request.source, operation: request.operation });
  }

  #checkIdempotency(request) {
    const prior = this.#idempotency.get(request.idempotencyKey);
    if (!prior) return;
    if (prior.principal !== request.principal || prior.fingerprint !== this.#requestFingerprint(request)) {
      throw new HostError('AUTOMATION_API_REPLAY_CONFLICT', 'Automation API idempotency key belongs to another caller or request.', 409);
    }
  }

  #rememberJob(request, job) {
    plain(job, 'Automation API job');
    const owner = Object.freeze({
      principal: request.principal,
      source: request.source ?? null,
      operation: request.operation ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
      expectedType: operationType(request.operation),
    });
    const existing = this.#jobOwners.get(job.id);
    if (existing) {
      const existingFingerprint = JSON.stringify({
        principal: existing.principal, source: existing.source,
        operation: existing.operation, idempotencyKey: existing.idempotencyKey,
      });
      const ownerFingerprint = JSON.stringify({
        principal: owner.principal, source: owner.source,
        operation: owner.operation, idempotencyKey: owner.idempotencyKey,
      });
      if (existingFingerprint !== ownerFingerprint) {
        throw new HostError('AUTOMATION_API_REPLAY_CONFLICT', 'Automation API job ownership does not match the submitted request.', 409);
      }
    }
    this.#jobOwners.set(job.id, existing ?? owner);
    if (request.idempotencyKey) this.#idempotency.set(request.idempotencyKey, Object.freeze({ principal: request.principal, fingerprint: this.#requestFingerprint(request), jobId: job.id }));
    return this.#jobOwners.get(job.id);
  }

  #ownerFor(request) {
    const owner = this.#jobOwners.get(request.jobId);
    if (!owner || owner.principal !== request.principal) {
      throw new HostError('AUTOMATION_API_RESOURCE_NOT_FOUND', 'Automation API job was not found.', 404);
    }
    return owner;
  }

  #publicOwnedJob(job, request, owner) {
    if (job?.id !== request.jobId || job?.type !== owner.expectedType) {
      throw new HostError('AUTOMATION_API_RESULT_INVALID', 'Automation API job identity changed unexpectedly.', 502);
    }
    return publicJob(job);
  }

  #rememberOutput(job, owner) {
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 8) return;
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      if (Object.getPrototypeOf(value) !== Object.prototype) return;
      if (value.durableOutput && typeof value.durableOutput === 'object') {
        const output = value.durableOutput;
        if (typeof output.id === 'string' && typeof output.sha256 === 'string') {
          this.#outputOwners.set(output.id, Object.freeze({
            principal: owner.principal,
            jobId: job.id,
            sha256: output.sha256,
            source: owner.source,
          }));
        }
      }
      for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(job.receipt);
  }

  #outputOwner(request) {
    const owner = this.#outputOwners.get(request.outputId);
    if (!owner || owner.principal !== request.principal || owner.jobId !== request.jobId || owner.sha256 !== request.outputSha256) {
      throw new HostError('AUTOMATION_API_RESOURCE_NOT_FOUND', 'Automation API output was not found.', 404);
    }
    return owner;
  }

  async #openSource(request) {
    let opened;
    try { opened = await this.#sources.openVerified(request.source.id, request.source.sha256); } catch (error) { throw mappedError(error, 'AUTOMATION_API_SOURCE_NOT_FOUND', 404); }
    try { return sourceBinding(opened, request.source); }
    finally { opened?.stream?.destroy?.(); }
  }

  #registryRequest(source, operation) {
    try {
      if (operation.kind === 'preset') return this.#registry.enqueuePresetRequest(source, operation.id);
      if (operation.kind === 'sequence') return this.#registry.enqueueSequenceRequest(source, operation.id);
      if (operation.id === AUTOMATION_INSPECT_TYPE) return this.#registry.enqueueRequest(source);
      if (operation.id === AUTOMATION_OCR_TYPE) return this.#registry.enqueueOcrRequest(source);
      if (operation.id === AUTOMATION_OUTPUT_INTENT_TYPE) return this.#registry.enqueueOutputIntentRequest(source);
      if (operation.id === AUTOMATION_FULL_PAGE_REDACTION_TYPE) return this.#registry.enqueueFullPageRedactionRequest(source, { pages: operation.pages });
      throw new HostError('AUTOMATION_API_OPERATION_DENIED', 'Automation API operation is not allowlisted.', 403);
    } catch (error) {
      if (error instanceof HostError && error.code === 'AUTOMATION_API_OPERATION_DENIED') throw error;
      throw mappedError(error, 'AUTOMATION_API_OPERATION_DENIED', 403);
    }
  }

  #queuedSubmission(value, operation, transaction) {
    plain(value, 'Automation API queue response');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => !['idempotent', 'job'].includes(key))
      || typeof value.idempotent !== 'boolean') throw new HostError('AUTOMATION_API_RESULT_INVALID', 'Automation API queue response is invalid.', 502);
    plain(value.job, 'Automation API queue job');
    const job = publicJob(value.job);
    if (job.type !== operation.type || !sameSubmissionData(value.job.payload, operation.payload)
      || !sameSubmissionData(value.job.transaction, { source: transaction, output: null })) {
      throw new HostError('AUTOMATION_API_RESULT_INVALID', 'Automation API queue job does not match the submitted request.', 502);
    }
    return Object.freeze({ job: value.job, idempotent: value.idempotent });
  }

  async #admittedSubmission(request, operation, transaction) {
    let admission;
    try { admission = await this.#queue.admission(request.idempotencyKey); }
    catch (cause) { throw new HostError('AUTOMATION_API_ADMISSION_UNCERTAIN', 'Automation API admission could not be confirmed.', 503, { cause }); }
    if (!admission?.existing) return null;
    try {
      return this.#queuedSubmission({ job: admission.existing, idempotent: true }, operation, transaction);
    } catch (cause) {
      throw new HostError('AUTOMATION_API_ADMISSION_CONFLICT', 'Automation API admission conflicts with the durable queue.', 409, { cause });
    }
  }

  async #commitAcceptedSource(source) {
    try { await this.#sources.commit(source); }
    catch (cause) { throw new HostError('AUTOMATION_API_SOURCE_COMMIT_UNCERTAIN', 'Automation API admission completed but source finalization requires recovery.', 503, { cause }); }
  }

  async #finishSubmission(request, accepted, source) {
    try { this.#rememberJob(request, accepted.job); }
    catch (cause) {
      if (cause?.code === 'AUTOMATION_API_REPLAY_CONFLICT') throw cause;
      throw new HostError('AUTOMATION_API_ADMISSION_UNCERTAIN', 'Automation API admission could not be finalized.', 503, { cause });
    }
    await this.#commitAcceptedSource(source);
    return Object.freeze({ schemaVersion: 1, idempotent: accepted.idempotent, job: publicJob(accepted.job) });
  }

  async submit(value) {
    const request = normalizeAutomationApiSubmitRequest(value);
    await this.#authorize(request, 'submit', request.operation);
    this.#checkIdempotency(request);
    const source = await this.#openSource(request);
    const transaction = sourceTransaction(source);
    const operation = this.#registryRequest(source, request.operation);
    plain(operation, 'Automation API operation');
    const operationKeys = Reflect.ownKeys(operation);
    if (operationKeys.length !== 2 || operationKeys.some((key) => !['payload', 'type'].includes(key))) {
      throw new HostError('AUTOMATION_API_RESULT_INVALID', 'Automation API operation request is invalid.', 502);
    }
    let accepted;
    try { accepted = this.#queuedSubmission(await this.#queue.enqueue({ ...operation, idempotencyKey: request.idempotencyKey, transaction }), operation, transaction); }
    catch (error) {
      const recovered = await this.#admittedSubmission(request, operation, transaction);
      if (!recovered) throw mappedError(error);
      accepted = recovered;
    }
    return this.#finishSubmission(request, accepted, source);
  }

  async status(value) {
    const request = normalizeAutomationApiStatusRequest(value);
    await this.#authorize(request, 'status');
    const owner = this.#ownerFor(request);
    try {
      const job = await this.#queue.get(request.jobId);
      if (job?.id !== request.jobId) throw new HostError('AUTOMATION_API_RESOURCE_NOT_FOUND', 'Automation API job was not found.', 404);
      const publicValue = this.#publicOwnedJob(job, request, owner);
      this.#rememberOutput(publicValue, owner);
      return publicValue;
    } catch (error) { throw mappedError(error, 'AUTOMATION_API_JOB_NOT_FOUND', 404); }
  }

  getStatus(value) { return this.status(value); }

  async poll(value) {
    const request = normalizeAutomationApiPollRequest(value);
    await this.#authorize(request, 'status');
    const owner = this.#ownerFor(request);
    const deadline = this.#clock() + request.maxWaitMs;
    while (true) {
      let job;
      try {
        const raw = await this.#queue.get(request.jobId);
        if (raw?.id !== request.jobId) throw new HostError('AUTOMATION_API_RESOURCE_NOT_FOUND', 'Automation API job was not found.', 404);
        job = this.#publicOwnedJob(raw, request, owner);
        this.#rememberOutput(job, owner);
      } catch (error) { throw mappedError(error, 'AUTOMATION_API_JOB_NOT_FOUND', 404); }
      if (['completed', 'failed', 'cancelled'].includes(job.status) || this.#clock() >= deadline) return job;
      await this.#sleep(Math.min(50, Math.max(1, deadline - this.#clock())));
    }
  }

  async cancel(value) {
    const request = normalizeAutomationApiCancelRequest(value);
    await this.#authorize(request, 'cancel');
    this.#ownerFor(request);
    try {
      if (this.#worker && typeof this.#worker.cancel === 'function') await this.#worker.cancel(request.jobId);
      else await this.#queue.cancel(request.jobId);
      const job = await this.#queue.get(request.jobId);
      return this.#publicOwnedJob(job, request, this.#ownerFor(request));
    } catch (error) { throw mappedError(error, 'AUTOMATION_API_JOB_NOT_FOUND', 404); }
  }

  async output(value) {
    const request = normalizeAutomationApiOutputRequest(value);
    await this.#authorize(request, 'output');
    this.#ownerFor(request);
    const owner = this.#outputOwner(request);
    let metadata;
    try { metadata = await this.#sources.getOutputMetadata(request.outputId); } catch (error) { throw mappedError(error, 'AUTOMATION_API_OUTPUT_NOT_FOUND', 404); }
    plain(metadata, 'Automation API output metadata');
    if (metadata.id !== request.outputId || !OPAQUE_ID.test(metadata.id ?? '') || metadata.sha256 !== request.outputSha256
      || !SHA256.test(metadata.sha256 ?? '') || !OPAQUE_ID.test(metadata.sourceId ?? '') || !SHA256.test(metadata.sourceSha256 ?? '')
      || metadata.sourceId !== owner.source?.id || metadata.sourceSha256 !== owner.source?.sha256
      || !Number.isSafeInteger(metadata.size) || metadata.size < 1
      || Object.keys(metadata).some((key) => /(?:path|bytes|secret|token|stream)/iu.test(key))) {
      throw new HostError('AUTOMATION_API_OUTPUT_NOT_FOUND', 'Automation API output was not found.', 404);
    }
    return Object.freeze({ id: metadata.id, sha256: metadata.sha256, size: metadata.size, sourceId: metadata.sourceId, sourceSha256: metadata.sourceSha256 });
  }

  outputMetadata(value) { return this.output(value); }
}

export function createAutomationApi(options) { return new AutomationApiService(options); }

export {
  normalizeAutomationApiCancelRequest,
  normalizeAutomationApiOutputRequest,
  normalizeAutomationApiPollRequest,
  normalizeAutomationApiStatusRequest,
  normalizeAutomationApiSubmitRequest,
} from './automation-api-contract.mjs';
