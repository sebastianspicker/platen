import { HostError } from './host-error.mjs';
import { validateOperationProvenance } from './operation-provenance.mjs';

export const REDACTION_BATCH_PROFILE = 'source-bound-redaction-batch-v1';
export const REDACTION_BATCH_MAX_DOCUMENTS = 32;
const APPLY_PROFILE = 'source-bound-redaction-application-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const fail = (code, message, status = 400, cause) => {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
};

function plainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REDACTION_BATCH', `${label} must be a plain object.`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    fail('INVALID_REDACTION_BATCH', `${label} could not be inspected.`, 400, error);
  }
  if (prototype !== Object.prototype || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
    fail('INVALID_REDACTION_BATCH', `${label} must contain data properties only.`);
  }
  return descriptors;
}

function exactRecord(value, keys, label) {
  const descriptors = plainRecord(value, label);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    fail('INVALID_REDACTION_BATCH', `${label} has an unexpected shape.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function dataArray(value, label, maximum = 1024) {
  if (!Array.isArray(value)) fail('INVALID_REDACTION_BATCH', `${label} must be an array.`);
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    fail('INVALID_REDACTION_BATCH', `${label} could not be inspected.`, 400, error);
  }
  if (prototype !== Array.prototype || !Object.hasOwn(descriptors, 'length')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
    fail('INVALID_REDACTION_BATCH', `${label} must be a plain data array.`);
  }
  const length = descriptors.length.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Object.keys(descriptors).some((key) => key !== 'length' && (!/^\d+$/u.test(key) || Number(key) >= length))) {
    fail('INVALID_REDACTION_BATCH', `${label} has an invalid array shape.`);
  }
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) fail('INVALID_REDACTION_BATCH', `${label} must not contain holes.`);
    values.push(descriptor.value);
  }
  return values;
}

function freezeCopy(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach(freezeCopy);
  } else {
    Object.values(value).forEach(freezeCopy);
  }
  return Object.freeze(value);
}

function checkedPlan(value, itemIndex) {
  const plan = exactRecord(value, [
    'schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision',
    'planId', 'planSha256', 'markIds',
  ], `documents[${itemIndex}].plan`);
  if (plan.schemaVersion !== 1 || plan.profile !== APPLY_PROFILE
    || !SHA256.test(plan.sourceSha256 ?? '') || !Number.isSafeInteger(plan.expectedWorkspaceRevision)
    || plan.expectedWorkspaceRevision < 0 || !ID.test(plan.planId ?? '') || !SHA256.test(plan.planSha256 ?? '')
    || !Array.isArray(plan.markIds)) {
    fail('INVALID_REDACTION_BATCH', `documents[${itemIndex}].plan is not an exact source-bound application plan.`);
  }
  const markIds = dataArray(plan.markIds, `documents[${itemIndex}].plan.markIds`, 64);
  if (markIds.length < 1 || markIds.length > 64 || markIds.some((id) => !ID.test(id ?? '')) || new Set(markIds).size !== markIds.length) {
    fail('INVALID_REDACTION_BATCH', `documents[${itemIndex}].plan mark IDs are invalid.`);
  }
  return Object.freeze({ ...plan, markIds: Object.freeze([...markIds]) });
}

function checkedRequest(value) {
  const request = exactRecord(value, ['profile', 'documents'], 'batch request');
  if (request.profile !== REDACTION_BATCH_PROFILE || !Array.isArray(request.documents)) {
    fail('INVALID_REDACTION_BATCH', `Batch request must contain 1-${REDACTION_BATCH_MAX_DOCUMENTS} documents.`);
  }
  const rawDocuments = dataArray(request.documents, 'batch request.documents', REDACTION_BATCH_MAX_DOCUMENTS);
  if (rawDocuments.length < 1 || rawDocuments.length > REDACTION_BATCH_MAX_DOCUMENTS) fail('INVALID_REDACTION_BATCH', `Batch request must contain 1-${REDACTION_BATCH_MAX_DOCUMENTS} documents.`);
  const documents = rawDocuments.map((entry, index) => {
    const item = exactRecord(entry, ['documentId', 'sourceSha256', 'plan'], `documents[${index}]`);
    if (!ID.test(item.documentId ?? '') || !SHA256.test(item.sourceSha256 ?? '')) {
      fail('INVALID_REDACTION_BATCH', `documents[${index}] requires a bounded document ID and lowercase source digest.`);
    }
    const plan = checkedPlan(item.plan, index);
    if (plan.sourceSha256 !== item.sourceSha256) {
      fail('REDACTION_BATCH_SOURCE_MISMATCH', `documents[${index}] plan and source digests differ.`, 409);
    }
    return Object.freeze({ documentId: item.documentId, sourceSha256: item.sourceSha256, plan });
  });
  const documentIds = new Set();
  const planIds = new Set();
  for (const item of documents) {
    if (documentIds.has(item.documentId)) fail('REDACTION_BATCH_DUPLICATE_DOCUMENT', 'A batch cannot contain the same document twice.', 409);
    if (planIds.has(item.plan.planId)) fail('REDACTION_BATCH_DUPLICATE_PLAN', 'A batch cannot contain the same plan twice.', 409);
    documentIds.add(item.documentId); planIds.add(item.plan.planId);
  }
  // Canonical order makes execution and returned inventories independent of caller ordering.
  documents.sort((left, right) => left.documentId.localeCompare(right.documentId));
  return Object.freeze({ profile: REDACTION_BATCH_PROFILE, documents: Object.freeze(documents) });
}

function abort(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'Redaction batch was cancelled.', 499);
}

function artifactShape(value, item, index) {
  const artifact = exactRecord(value, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'], `documents[${index}] artifact`);
  if (!ID.test(artifact.id ?? '') || artifact.documentId !== item.documentId || typeof artifact.displayName !== 'string'
    || artifact.displayName.length < 1 || artifact.displayName.length > 255 || artifact.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || !SHA256.test(artifact.sha256 ?? '')
    || artifact.operation === null || typeof artifact.operation !== 'object' || Array.isArray(artifact.operation)
    || typeof artifact.createdAt !== 'string' || artifact.createdAt.length < 1 || artifact.createdAt.length > 100) {
    fail('REDACTION_BATCH_ARTIFACT_INVALID', `documents[${index}] returned an invalid promoted artifact.`, 502);
  }
  let provenance;
  try { provenance = validateOperationProvenance(artifact.operation); } catch (error) {
    fail('REDACTION_BATCH_ARTIFACT_INVALID', `documents[${index}] artifact provenance is invalid.`, 502, error);
  }
  if (!provenance.inputs.some((input) => input.documentId === item.documentId && input.sha256 === item.sourceSha256)
    || provenance.validation.passed !== true || provenance.type !== 'raster-redact'
    || provenance.parameters?.planBinding?.planId !== item.plan.planId
    || provenance.parameters?.planBinding?.planSha256 !== item.plan.planSha256
    || provenance.parameters?.planBinding?.workspaceRevision !== item.plan.expectedWorkspaceRevision
    || JSON.stringify(provenance.parameters?.planBinding?.markIds) !== JSON.stringify(item.plan.markIds)) {
    fail('REDACTION_BATCH_ARTIFACT_INVALID', `documents[${index}] artifact provenance is not source-bound.`, 502);
  }
  return Object.freeze(artifact);
}

export class PdfRedactionBatchService {
  #store;
  #plans;
  #commit;

  constructor({ store, documentStore, redactionPlans, redactionPlanService, commitBatch } = {}) {
    store ??= documentStore;
    redactionPlans ??= redactionPlanService;
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function'
      || typeof store.deleteArtifact !== 'function') {
      throw new TypeError('PdfRedactionBatchService requires a document store with source verification and artifact revocation.');
    }
    if (!redactionPlans || typeof redactionPlans.applyPlan !== 'function') {
      throw new TypeError('PdfRedactionBatchService requires the verified redaction plan primitive.');
    }
    if (commitBatch !== undefined && typeof commitBatch !== 'function') throw new TypeError('commitBatch must be a function.');
    this.#store = store;
    this.#plans = redactionPlans;
    this.#commit = commitBatch ?? (async (results) => results);
  }

  async apply(value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = checkedRequest(value);
    const existingIds = new Set();
    const preexistingIds = await this.#artifactIds();
    const preflight = [];
    try {
      abort(signal);
      for (const item of request.documents) {
        const source = this.#store.getDocument(item.documentId);
        if (!source || source.sha256 !== item.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'A batch source digest does not match the immutable document.', 409);
        if (source.sha256 !== item.plan.sourceSha256) fail('REDACTION_BATCH_SOURCE_MISMATCH', 'A batch plan is not bound to its immutable source.', 409);
        await this.#store.verifySource(item.documentId);
        if (this.#store.getDocument(item.documentId).sha256 !== item.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'A batch source changed during preflight.', 409);
        preflight.push(item);
      }
      const results = [];
      const promoted = [];
      try {
        for (const [index, item] of preflight.entries()) {
          abort(signal);
          const result = await this.#plans.applyPlan(item.documentId, item.plan, { signal });
          const candidate = result?.artifact;
          if (candidate?.id && preexistingIds?.has(candidate.id)) fail('REDACTION_BATCH_STALE_ARTIFACT', 'A redaction primitive returned an artifact that existed before this batch.', 409);
          if (candidate?.id) promoted.push(candidate.id);
          const artifact = artifactShape(candidate, item, index);
          if (existingIds.has(artifact.id)) {
            fail('REDACTION_BATCH_OUTPUT_COLLISION', 'A batch output artifact collides with an existing artifact.', 409);
          }
          existingIds.add(artifact.id);
          if (results.some(({ artifact: prior }) => prior.displayName === artifact.displayName)) {
            fail('REDACTION_BATCH_OUTPUT_COLLISION', 'A batch output filename collides with another batch result.', 409);
          }
          results.push(Object.freeze({ documentId: item.documentId, sourceSha256: item.sourceSha256, artifact }));
          await this.#store.verifySource(item.documentId);
          if (this.#store.getDocument(item.documentId).sha256 !== item.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'A batch source changed during processing.', 409);
          abort(signal);
        }
        abort(signal);
        // Resolution of the external commit is the single terminal
        // linearization point. Cancellation observed after this await cannot
        // revoke outputs that the commit may already have durably recorded.
        await this.#commit(Object.freeze(results.map((entry) => Object.freeze({ ...entry }))));
        return freezeCopy({
          kind: 'pdf-redaction-batch', profile: REDACTION_BATCH_PROFILE, status: 'committed',
          documents: results, count: results.length, sourceUnchanged: true, localOnly: true,
          commit: Object.freeze({ status: 'committed' }),
        });
      } catch (error) {
        await this.#rollback(promoted, error);
        throw error;
      }
    } catch (error) {
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') fail('JOB_CANCELLED', 'Redaction batch was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      throw new HostError('REDACTION_BATCH_FAILED', 'The redaction batch could not be completed.', 502, { cause: error });
    }
  }

  applyBatch(value, options) { return this.apply(value, options); }
  redact(value, options) { return this.apply(value, options); }
  run(value, options) { return this.apply(value, options); }
  execute(value, options) { return this.apply(value, options); }

  async #rollback(ids, original) {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
    const failures = [];
    for (const id of unique.reverse()) {
      try { await this.#store.deleteArtifact(id); } catch (error) { if (error?.code !== 'ARTIFACT_NOT_FOUND') failures.push(error); }
    }
    if (failures.length) fail('REDACTION_BATCH_ROLLBACK_FAILED', 'A failed redaction batch could not revoke every staged output.', 500, new AggregateError([original, ...failures]));
  }

  async #artifactIds() {
    try {
      if (typeof this.#store.listArtifactIds === 'function') return new Set(await this.#store.listArtifactIds());
      if (typeof this.#store.listArtifacts === 'function') {
        const records = await this.#store.listArtifacts();
        return new Set((Array.isArray(records) ? records : []).map((record) => record?.id).filter((id) => typeof id === 'string'));
      }
    } catch (error) {
      fail('REDACTION_BATCH_ARTIFACT_INVENTORY_FAILED', 'Existing artifact inventory could not be read safely.', 500, error);
    }
    return null;
  }
}

export function createPdfRedactionBatchService(options) {
  return new PdfRedactionBatchService(options);
}

export const RedactionBatchService = PdfRedactionBatchService;
export const createRedactionBatchService = createPdfRedactionBatchService;
