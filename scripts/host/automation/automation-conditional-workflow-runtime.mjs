import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { inspectionReceipt } from './automation-operation-results.mjs';

function runtimeFail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exactFacts(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) runtimeFail('AUTOMATION_CONDITIONAL_FACTS_INVALID', 'Verified conditional facts are invalid.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ['encrypted', 'optimized', 'pageCount', 'source', 'tagged'];
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) runtimeFail('AUTOMATION_CONDITIONAL_FACTS_INVALID', 'Verified conditional facts contain unsupported fields or accessors.');
  const binding = descriptors.source.value;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || nodeTypes.isProxy(binding)
    || Object.getPrototypeOf(binding) !== Object.prototype) runtimeFail('AUTOMATION_CONDITIONAL_FACTS_INVALID', 'Verified conditional source binding is invalid.');
  const sourceDescriptors = Object.getOwnPropertyDescriptors(binding);
  if (Reflect.ownKeys(binding).length !== 2 || !Object.hasOwn(sourceDescriptors, 'id') || !Object.hasOwn(sourceDescriptors, 'sha256')
    || !Object.hasOwn(sourceDescriptors.id, 'value') || !Object.hasOwn(sourceDescriptors.sha256, 'value')
    || sourceDescriptors.id.value !== source.id || sourceDescriptors.sha256.value !== source.sha256) runtimeFail('AUTOMATION_CONDITIONAL_SOURCE_DRIFT', 'Verified conditional facts do not match the source.', 409);
  const pageCount = descriptors.pageCount.value;
  const values = ['encrypted', 'optimized', 'tagged'].map((key) => descriptors[key].value);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100_000
    || values.some((item) => item !== null && typeof item !== 'boolean')) runtimeFail('AUTOMATION_CONDITIONAL_FACTS_INVALID', 'Verified conditional fact values are invalid.');
  return Object.freeze({ source: Object.freeze({ id: source.id, sha256: source.sha256 }), pageCount,
    encrypted: values[0], optimized: values[1], tagged: values[2] });
}

function compare(actual, operator, expected) {
  if (actual === null || actual === undefined) return false;
  if (operator === 'eq') return actual === expected;
  if (operator === 'gte') return actual >= expected;
  if (operator === 'lte') return actual <= expected;
  return false;
}

function conditionValue(field, facts, state) {
  if (field === 'document.pageCount') return facts.pageCount;
  if (field === 'document.encrypted') return facts.encrypted;
  if (field === 'document.tagged') return facts.tagged;
  if (field === 'document.optimized') return facts.optimized;
  if (field === 'workflow.queuedCount') return state.queuedCount;
  if (field === 'workflow.previousStatus') return state.previousStatus;
  return undefined;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new HostError('AUTOMATION_CONDITIONAL_CANCELLED', 'Conditional workflow was cancelled.', 499);
}

function occurrenceKey(executionId, stepId, branch, iteration) {
  return `conditional:${executionId}:${stepId}:${branch}:${iteration}`;
}

export async function executeAutomationConditionalWorkflow({ request, facts, submit, signal }) {
  if (typeof submit !== 'function') throw new TypeError('Conditional workflow runtime requires a submit function.');
  const checkedFacts = exactFacts(facts, request.source);
  const executionId = request.executionId;
  const state = { queuedCount: 0, previousStatus: 'none' };
  const steps = [];
  for (const step of request.workflow.steps) {
    throwIfCancelled(signal);
    const matched = compare(conditionValue(step.condition.field, checkedFacts, state), step.condition.operator, step.condition.value);
    const branchName = matched ? 'true' : 'false';
    const branch = matched ? step.trueBranch : step.falseBranch;
    if (branch.operation === null) {
      state.previousStatus = 'skipped';
      steps.push(Object.freeze({ stepId: step.stepId, matched, branch: branchName, status: 'skipped', jobs: Object.freeze([]) }));
      continue;
    }
    const jobs = [];
    for (let iteration = 1; iteration <= branch.repeat; iteration += 1) {
      throwIfCancelled(signal);
      const queued = await submit(branch.operation, occurrenceKey(executionId, step.stepId, branchName, iteration));
      jobs.push(Object.freeze({ iteration, id: queued.id, status: queued.status, idempotent: queued.idempotent }));
      state.queuedCount += 1;
    }
    state.previousStatus = 'queued';
    steps.push(Object.freeze({ stepId: step.stepId, matched, branch: branchName, status: 'queued', jobs: Object.freeze(jobs) }));
  }
  const factsDigest = createHash('sha256').update(JSON.stringify(checkedFacts), 'utf8').digest('hex');
  return Object.freeze({ schemaVersion: 1, executionId, workflowId: request.workflow.workflowId,
    source: Object.freeze({ id: request.source.id, sha256: request.source.sha256 }), factsDigest,
    queuedCount: state.queuedCount, status: 'completed', steps: Object.freeze(steps), localOnly: true });
}

export class LocalConditionalWorkflowFactsProvider {
  #sources; #store; #service;

  constructor({ sources, store, service } = {}) {
    if (typeof sources?.openVerified !== 'function' || typeof store?.createDocument !== 'function'
      || typeof store?.deleteDocument !== 'function' || typeof service?.inspect !== 'function') {
      throw new TypeError('Conditional workflow facts require source storage, DocumentStore, and PdfService.');
    }
    this.#sources = sources; this.#store = store; this.#service = service;
  }

  async inspectVerified(source, { signal } = {}) {
    throwIfCancelled(signal);
    const opened = await this.#sources.openVerified(source.id, source.sha256);
    if (!opened || opened.id !== source.id || opened.sha256 !== source.sha256
      || !Number.isSafeInteger(opened.size) || opened.size < 5 || typeof opened.stream?.destroy !== 'function') {
      opened?.stream?.destroy?.();
      runtimeFail('AUTOMATION_CONDITIONAL_SOURCE_DRIFT', 'Conditional source binding is invalid.', 409);
    }
    let document = null;
    let result;
    const failures = [];
    try {
      document = await this.#store.createDocument({ stream: opened.stream, displayName: 'conditional-source.pdf', mediaType: 'application/pdf' });
      if (document.sha256 !== source.sha256 || document.size !== opened.size) runtimeFail('AUTOMATION_CONDITIONAL_SOURCE_DRIFT', 'Conditional source changed while being inspected.', 409);
      const receipt = inspectionReceipt(opened, await this.#service.inspect(document.id, { signal }));
      result = Object.freeze({ source: Object.freeze({ id: source.id, sha256: source.sha256 }), pageCount: receipt.pageCount,
        encrypted: receipt.encrypted, optimized: receipt.optimized, tagged: receipt.tagged });
    } catch (error) { failures.push(error); }
    try { opened?.stream?.destroy?.(); } catch (error) { failures.push(error); }
    try { if (document) await this.#store.deleteDocument(document.id); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Conditional inspection and cleanup failed.');
    return result;
  }
}
