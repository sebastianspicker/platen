import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { queryAnnotations } from './domains/review-forms-review-query.mjs';
import { reviewSummary } from './domains/review-forms-review-interchange.mjs';
import {
  REVIEW_SIDECAR_INSPECTION_KIND,
  REVIEW_SIDECAR_STATUS_KIND,
  freezeReviewSidecarResult,
  normalizeReviewSidecarInspectionRequest,
  normalizeReviewSidecarStatusRequest,
} from './pdf-review-sidecar-contract.mjs';

const MAX_REVIEW_RECORDS = 500;
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 1_000;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 10_000;
const LIMITATIONS = Object.freeze(['Local session sidecar only; no PDF annotations are read or written.']);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Review sidecar processing was cancelled.', 499); }
function assertSignal(signal) { if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); }

// Copy descriptor values only. This prevents a hostile workspace adapter from running
// getters while a source-bound operation decides what to retain or replace.
function copyJson(value, label = 'workspace snapshot', depth = 0) {
  if (depth > MAX_DEPTH) fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} is too deeply nested.`, 409);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} contains a non-finite number.`, 409);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} contains an overlong string.`, 409);
    return value;
  }
  if (!value || typeof value !== 'object' || isProxy(value)) fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} must be JSON data.`, 409);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_LENGTH
      || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) {
      fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} must be a bounded dense data array.`, 409);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => key !== 'length'
      && (!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
        || descriptors[key].enumerable !== true))) {
      fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} contains an accessor or unsupported field.`, 409);
    }
    return value.map((item, index) => copyJson(descriptors[String(index)].value, `${label}[${index}]`, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} must be a plain data object.`, 409);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_OBJECT_KEYS || keys.some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) {
    fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', `${label} contains an accessor, symbol, or unsupported field.`, 409);
  }
  return Object.fromEntries(keys.map((key) => [key, copyJson(descriptors[key].value, `${label}.${key}`, depth + 1)]));
}

function snapshotData(value, documentId, expectedRevision) {
  const snapshot = copyJson(value);
  if (snapshot.documentId !== documentId || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0 || snapshot.revision !== expectedRevision
    || !snapshot.namespaces || typeof snapshot.namespaces !== 'object'
    || !Array.isArray(snapshot.namespaces.annotations) || !Array.isArray(snapshot.namespaces.reviewRecords)
    || !Array.isArray(snapshot.audit)) {
    fail('REVISION_CONFLICT', 'Workspace revision does not match the review sidecar request.', 409);
  }
  for (const record of snapshot.namespaces.annotations) {
    if (typeof record?.id !== 'string') fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', 'Annotations namespace contains a malformed record.', 409);
  }
  return snapshot;
}

function sourceMismatch() { fail('REVIEW_SIDECAR_SOURCE_MISMATCH', 'Review sidecar source digest does not match the current local document.', 409); }

function activityId(annotationId, revision) {
  return `sidecar-${revision}-${createHash('sha256').update(annotationId, 'utf8').digest('hex').slice(0, 32)}`;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) {
    fail('REVIEW_SIDECAR_CLOCK_INVALID', 'Review sidecar clock returned an invalid timestamp.', 500);
  }
  return value;
}

function retainedActivities(snapshot) {
  const keys = ['id', 'kind', 'annotationId', 'activity', 'actor', 'detail', 'at'];
  return snapshot.namespaces.reviewRecords
    .filter((record) => record.kind === 'activity' && keys.every((key) => Object.hasOwn(record, key)))
    .map((record) => Object.fromEntries(keys.map((key) => [key, record[key]])));
}

function queryForDomain(query) {
  return {
    ...query,
    status: query.status === null ? undefined : query.status,
    type: query.type === null ? undefined : query.type,
  };
}

function inspectionCount(result) {
  if (Array.isArray(result)) return result.length;
  return Object.values(result).reduce((total, group) => total + group.length, 0);
}

export class PdfReviewSidecarService {
  #documents;
  #workspace;
  #clock;

  constructor({ documents, workspace, clock = () => new Date().toISOString() } = {}) {
    if (!documents || typeof documents.getDocument !== 'function' || typeof documents.verifySource !== 'function') {
      throw new TypeError('PdfReviewSidecarService requires a document store with source verification.');
    }
    if (!workspace || typeof workspace.snapshot !== 'function' || typeof workspace.replaceSnapshot !== 'function'
      || typeof workspace.acquireReadLease !== 'function') {
      throw new TypeError('PdfReviewSidecarService requires a lease-capable workspace store.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    this.#documents = documents;
    this.#workspace = workspace;
    this.#clock = clock;
  }

  async #verifySource(documentId, sourceSha256) {
    const initial = this.#documents.getDocument(documentId);
    if (initial?.sha256 !== sourceSha256) sourceMismatch();
    await this.#documents.verifySource(documentId);
    const current = this.#documents.getDocument(documentId);
    if (current?.sha256 !== sourceSha256) sourceMismatch();
  }

  async setStatus(documentId, value, { signal } = {}) {
    assertSignal(signal);
    const request = normalizeReviewSidecarStatusRequest(value);
    abort(signal);
    await this.#verifySource(documentId, request.sourceSha256);
    abort(signal);
    const snapshot = snapshotData(this.#workspace.snapshot(documentId), documentId, request.expectedRevision);
    const annotationIndex = snapshot.namespaces.annotations.findIndex((record) => record.id === request.annotationId);
    if (annotationIndex < 0) fail('ANNOTATION_NOT_FOUND', 'The local review annotation was not found.', 404);
    if (snapshot.namespaces.reviewRecords.length >= MAX_REVIEW_RECORDS) fail('REVIEW_SIDECAR_LIMIT_EXCEEDED', 'The local review activity limit has been reached.', 413);
    const records = snapshot.namespaces.reviewRecords.slice();
    const id = activityId(request.annotationId, snapshot.revision);
    if (records.some((record) => record.id === id)) fail('REVIEW_SIDECAR_ACTIVITY_CONFLICT', 'The retained review activity identifier conflicts with this update.', 409);
    const { customStatus: _previousCustomStatus, ...annotation } = snapshot.namespaces.annotations[annotationIndex];
    snapshot.namespaces.annotations[annotationIndex] = {
      ...annotation,
      status: request.status,
      ...(request.status === 'custom' ? { customStatus: request.customStatus } : {}),
    };
    records.push({
      id,
      kind: 'activity',
      annotationId: request.annotationId,
      activity: 'status',
      actor: 'local-sidecar',
      detail: request.status === 'custom' ? request.customStatus : request.status,
      at: timestamp(this.#clock()),
    });
    snapshot.namespaces.reviewRecords = records;
    await this.#verifySource(documentId, request.sourceSha256);
    abort(signal);
    const updated = this.#workspace.replaceSnapshot(documentId, snapshot, { expectedRevision: request.expectedRevision });
    if (!updated || !Number.isSafeInteger(updated.revision)) fail('REVIEW_SIDECAR_COMMIT_FAILED', 'Review sidecar did not receive a valid workspace commit.', 502);
    return freezeReviewSidecarResult({
      kind: REVIEW_SIDECAR_STATUS_KIND,
      sourceDigest: request.sourceSha256,
      revision: updated.revision,
      annotationId: request.annotationId,
      status: request.status,
      customStatus: request.customStatus,
      localOnly: true,
    });
  }

  async inspect(documentId, value, { signal } = {}) {
    assertSignal(signal);
    const request = normalizeReviewSidecarInspectionRequest(value);
    abort(signal);
    await this.#verifySource(documentId, request.sourceSha256);
    abort(signal);
    const lease = this.#workspace.acquireReadLease(documentId, { expectedRevision: request.expectedRevision });
    try {
      const snapshot = snapshotData(lease.snapshot, documentId, request.expectedRevision);
      await this.#verifySource(documentId, request.sourceSha256);
      abort(signal);
      snapshotData(lease.assertCurrent(), documentId, request.expectedRevision);
      let annotationsOrGroups;
      let summary;
      try {
        annotationsOrGroups = queryAnnotations(snapshot, queryForDomain(request.query));
        // Object.groupBy deliberately creates a null-prototype dictionary. The public
        // sidecar receipt is a plain, descriptor-checked data object instead.
        if (!Array.isArray(annotationsOrGroups)) annotationsOrGroups = Object.fromEntries(Object.entries(annotationsOrGroups));
        summary = reviewSummary(snapshot);
      } catch (error) {
        if (error instanceof HostError) throw error;
        fail('REVIEW_SIDECAR_INVALID_SNAPSHOT', 'The retained review sidecar records are malformed.', 409);
      }
      abort(signal);
      return freezeReviewSidecarResult({
        kind: REVIEW_SIDECAR_INSPECTION_KIND,
        sourceDigest: request.sourceSha256,
        revision: request.expectedRevision,
        annotationsOrGroups,
        count: inspectionCount(annotationsOrGroups),
        commentSummary: summary.commentSummary,
        activity: retainedActivities(snapshot),
        limitations: [...LIMITATIONS],
        localOnly: true,
      });
    } finally {
      lease.release();
    }
  }
}

export const createPdfReviewSidecarService = (options) => new PdfReviewSidecarService(options);
