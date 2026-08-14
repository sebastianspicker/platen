import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { canonicalizeProjectBundle } from './project-bundle-framing.mjs';
import { readZipEntries } from './zip-reader.mjs';
import { writeStoredZip } from './pdf-ooxml-export-zip.mjs';
import { createReviewNotification } from './pdf-review-notifications-contract.mjs';
import { mergeReviewNotifications } from './pdf-review-notifications-service.mjs';
import {
  REVIEW_SHARED_EXCHANGE_MAX_BYTES,
  REVIEW_SHARED_EXCHANGE_MEDIA_TYPE,
  REVIEW_SHARED_EXCHANGE_PROFILE,
  createReviewSharedExchangeManifest,
  normalizeReviewSharedExchangeRequest,
  parseReviewSharedExchangeDeltas,
  parseReviewSharedExchangeManifest,
  reviewSharedExchangeDigest,
} from './pdf-review-shared-exchange-contract.mjs';

const ZIP_NAMES = Object.freeze(['deltas.json', 'manifest.json']);
const REVIEW_ZIP_LIMITS = Object.freeze({ maximumEntries: 2, maximumEntryBytes: REVIEW_SHARED_EXCHANGE_MAX_BYTES, maximumArchiveBytes: REVIEW_SHARED_EXCHANGE_MAX_BYTES });
function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Review exchange processing was cancelled.', 499); }
function canonicalBytes(value) { return Buffer.from(canonicalizeProjectBundle(value), 'utf8'); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function parseJson(bytes, label) { let raw; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('REVIEW_SHARED_EXCHANGE_INVALID_UTF8', `${label} must be valid UTF-8.`); } let value; try { value = JSON.parse(raw); } catch { fail('REVIEW_SHARED_EXCHANGE_INVALID_JSON', `${label} must be valid JSON.`); } if (canonicalizeProjectBundle(value) !== raw) fail('REVIEW_SHARED_EXCHANGE_NONCANONICAL', `${label} must use canonical JSON.`); return value; }
function deltaHash(delta) { const unsigned = { id: delta.id, kind: delta.kind, annotationId: delta.annotationId, revision: delta.revision, timestamp: delta.timestamp, status: delta.status, authorId: delta.authorId, text: delta.text, payload: delta.payload }; return reviewSharedExchangeDigest(unsigned); }
function annotationDelta(annotation, reviewerId, revision) { const payload = { type: annotation.type, page: annotation.page, rectangle: annotation.rectangle, text: annotation.text ?? '', status: annotation.status ?? 'open', customStatus: annotation.customStatus ?? null, properties: annotation.properties ?? {}, mentions: annotation.mentions ?? [] }; const item = { id: annotation.id, kind: 'annotation', annotationId: null, revision, timestamp: annotation.createdAt, status: payload.status, authorId: annotation.author, text: '', payload, sha256: '' }; item.sha256 = deltaHash(item); return item; }
function commentDelta(annotationId, reply, reviewerId, revision) { const item = { id: reply.id, kind: 'comment', annotationId, revision, timestamp: reply.at, status: 'open', authorId: reply.author, text: reply.text, payload: null, sha256: '' }; item.sha256 = deltaHash(item); return item; }
function dataArray(value, label) { if (!Array.isArray(value) || isProxy(value) || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length || Object.getPrototypeOf(value) !== Array.prototype) fail('INVALID_REVIEW_SHARED_EXCHANGE', `${label} must be a dense data-only array.`); const descriptors = Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(value).some((key) => key !== 'length' && (!Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) fail('INVALID_REVIEW_SHARED_EXCHANGE', `${label} must be a dense data-only array.`); return value; }
function extractDeltas(snapshot, reviewerId) { const revision = snapshot.revision; const deltas = []; for (const annotation of dataArray(snapshot.namespaces.annotations, 'annotations')) { if (annotation.reference || annotation.measurement || annotation.stamp || annotation.attachments) fail('REVIEW_SHARED_EXCHANGE_UNSUPPORTED_ANNOTATION', 'Attachments and specialized annotation payloads are not exportable.'); deltas.push(annotationDelta(annotation, reviewerId, revision)); for (const reply of dataArray(annotation.replies ?? [], 'replies')) deltas.push(commentDelta(annotation.id, reply, reviewerId, revision)); } return deltas; }
function annotationEquivalent(existing, delta) { const payload = delta.payload; return existing?.id === delta.id && existing.author === delta.authorId && existing.type === payload.type && existing.page === payload.page && JSON.stringify(existing.rectangle) === JSON.stringify(payload.rectangle) && existing.text === payload.text && (existing.status ?? 'open') === payload.status && (existing.customStatus ?? null) === payload.customStatus && JSON.stringify(existing.properties ?? {}) === JSON.stringify(payload.properties) && JSON.stringify(existing.mentions ?? []) === JSON.stringify(payload.mentions) && existing.createdAt === delta.timestamp; }
function commentEquivalent(existing, delta) { return existing?.id === delta.id && existing.text === delta.text && existing.author === delta.authorId && existing.at === delta.timestamp; }
function mentionEvents(deltas, sourceSha256, revision) { const events = []; for (const delta of deltas) for (const mentionedReviewer of delta.payload?.mentions ?? []) events.push(createReviewNotification({ sourceSha256, workspaceRevision: revision, annotationId: delta.kind === 'annotation' ? delta.id : delta.annotationId, commentId: delta.kind === 'comment' ? delta.id : null, mentionedReviewer, actorId: delta.authorId, timestamp: delta.timestamp })); return events; }

export class PdfReviewSharedExchangeService {
  #documents; #workspace;
  constructor({ documents, workspace } = {}) { if (!documents || typeof documents.getDocument !== 'function' || typeof documents.verifySource !== 'function' || !workspace || typeof workspace.snapshot !== 'function' || typeof workspace.replaceSnapshot !== 'function') throw new TypeError('PdfReviewSharedExchangeService requires document and workspace stores.'); this.#documents = documents; this.#workspace = workspace; }
  async export(documentId, options = {}, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    abort(signal);
    const document = this.#documents.getDocument(documentId); const snapshot = this.#workspace.snapshot(documentId); const request = normalizeReviewSharedExchangeRequest(options, { sourceSha256: document.sha256, currentRevision: snapshot.revision }); await this.#documents.verifySource(documentId); const deltas = extractDeltas(snapshot, request.reviewerId);
    abort(signal);
    const manifest = createReviewSharedExchangeManifest({ sourceSha256: request.sourceSha256, baseRevision: request.baseRevision, reviewerId: request.reviewerId, deltas }); const deltaPayload = { schemaVersion: 1, deltas }; const bytes = writeStoredZip([['manifest.json', canonicalBytes(manifest)], ['deltas.json', canonicalBytes(deltaPayload)]], REVIEW_ZIP_LIMITS); if (bytes.length > REVIEW_SHARED_EXCHANGE_MAX_BYTES) fail('REVIEW_SHARED_EXCHANGE_TOO_LARGE', 'Review exchange package exceeds its fixed bound.', 413); await this.#documents.verifySource(documentId); const currentDocument = this.#documents.getDocument(documentId); if (currentDocument.sha256 !== request.sourceSha256) fail('REVIEW_SHARED_EXCHANGE_SOURCE_MISMATCH', 'Source PDF changed while exporting the review exchange.', 409); abort(signal); return Object.freeze({ bytes, displayName: 'review-exchange.platen.zip', mediaType: REVIEW_SHARED_EXCHANGE_MEDIA_TYPE, size: bytes.length, sha256: sha(bytes), manifest });
  }
  async import(documentId, input, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    abort(signal);
    if (!Buffer.isBuffer(input) || input.length < 1 || input.length > REVIEW_SHARED_EXCHANGE_MAX_BYTES) fail('REVIEW_SHARED_EXCHANGE_TOO_LARGE', 'Review exchange package exceeds its fixed bound.', 413);
    const packageBytes = Buffer.from(input); await this.#documents.verifySource(documentId); abort(signal);
    const entries = readZipEntries(packageBytes, { maximumEntries: 2, maximumEntryBytes: REVIEW_SHARED_EXCHANGE_MAX_BYTES, maximumExpandedBytes: REVIEW_SHARED_EXCHANGE_MAX_BYTES, maximumCompressionRatio: 100 });
    if (entries.size !== 2 || ZIP_NAMES.some((name) => !entries.has(name))) fail('REVIEW_SHARED_EXCHANGE_INVALID_ARCHIVE', 'Review exchange ZIP must contain exactly manifest.json and deltas.json.');
    const manifest = parseReviewSharedExchangeManifest(parseJson(entries.get('manifest.json'), 'manifest.json'));
    const currentDocument = this.#documents.getDocument(documentId);
    if (manifest.sourceSha256 !== currentDocument.sha256) fail('REVIEW_SHARED_EXCHANGE_SOURCE_MISMATCH', 'Review exchange belongs to a different source PDF.', 409);
    const deltas = parseReviewSharedExchangeDeltas(parseJson(entries.get('deltas.json'), 'deltas.json'), manifest);
    const snapshot = this.#workspace.snapshot(documentId);
    if (manifest.baseRevision > snapshot.revision) fail('REVIEW_SHARED_EXCHANGE_REVISION_CONFLICT', 'Review exchange base revision is ahead of the current workspace.', 409);
    const ids = new Set();
    for (const delta of deltas) { if (ids.has(delta.id)) fail('REVIEW_SHARED_EXCHANGE_DUPLICATE_ID', 'Review exchange contains duplicate delta identifiers.', 409); ids.add(delta.id); }
    const annotations = snapshot.namespaces.annotations.map((item) => ({ ...item, replies: (item.replies ?? []).map((reply) => ({ ...reply })) }));
    const byAnnotation = new Map(annotations.map((item) => [item.id, item])); let applied = 0;
    for (const delta of deltas) {
      abort(signal);
      if (delta.kind === 'annotation') {
        const existing = byAnnotation.get(delta.id);
        if (existing) { if (!annotationEquivalent(existing, delta)) fail('REVIEW_SHARED_EXCHANGE_CONFLICT', 'An annotation identifier has conflicting content.', 409); continue; }
        annotations.push({ id: delta.id, prototypeSidecar: true, type: delta.payload.type, page: delta.payload.page, rectangle: delta.payload.rectangle, text: delta.payload.text, author: delta.authorId, status: delta.payload.status, customStatus: delta.payload.customStatus, properties: delta.payload.properties, mentions: delta.payload.mentions, createdAt: delta.timestamp, replies: [] });
        byAnnotation.set(delta.id, annotations.at(-1)); applied += 1;
      } else {
        const annotation = byAnnotation.get(delta.annotationId);
        if (!annotation) fail('REVIEW_SHARED_EXCHANGE_CONFLICT', 'A comment targets a missing annotation.', 409);
        const existing = annotation.replies.find((reply) => reply.id === delta.id);
        if (existing) { if (!commentEquivalent(existing, delta)) fail('REVIEW_SHARED_EXCHANGE_CONFLICT', 'A comment identifier has conflicting content.', 409); continue; }
        annotation.replies.push({ id: delta.id, text: delta.text, author: delta.authorId, at: delta.timestamp }); applied += 1;
      }
    }
    const notificationMerge = mergeReviewNotifications({ ...snapshot, namespaces: { ...snapshot.namespaces, annotations } }, mentionEvents(deltas, manifest.sourceSha256, snapshot.revision), manifest.sourceSha256);
    if (snapshot.revision !== manifest.baseRevision && (applied > 0 || notificationMerge.added > 0)) fail('REVIEW_SHARED_EXCHANGE_REVISION_CONFLICT', 'Review exchange base revision does not match the current workspace.', 409);
    if (applied === 0 && notificationMerge.added === 0) return Object.freeze({ kind: REVIEW_SHARED_EXCHANGE_PROFILE, applied: 0, notificationsApplied: 0, idempotent: true, sourceSha256: manifest.sourceSha256, revision: snapshot.revision });
    await this.#documents.verifySource(documentId);
    const currentDocumentAfterVerify = this.#documents.getDocument(documentId);
    if (currentDocumentAfterVerify.sha256 !== manifest.sourceSha256) fail('REVIEW_SHARED_EXCHANGE_SOURCE_MISMATCH', 'Source PDF changed while importing the review exchange.', 409);
    abort(signal);
    const replacement = { documentId, revision: snapshot.revision, namespaces: { ...snapshot.namespaces, annotations, reviewRecords: notificationMerge.records }, audit: snapshot.audit };
    let updated;
    try {
      updated = this.#workspace.replaceSnapshot(documentId, replacement, { expectedRevision: snapshot.revision });
    } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT') throw error;
      const latest = this.#workspace.snapshot(documentId);
      const replayed = deltas.every((delta) => delta.kind === 'annotation'
        ? latest.namespaces.annotations.some((item) => annotationEquivalent(item, delta))
        : latest.namespaces.annotations.some((item) => item.id === delta.annotationId && dataArray(item.replies ?? [], 'replies').some((reply) => commentEquivalent(reply, delta))));
      if (replayed) return Object.freeze({ kind: REVIEW_SHARED_EXCHANGE_PROFILE, applied: 0, notificationsApplied: 0, idempotent: true, sourceSha256: manifest.sourceSha256, revision: latest.revision });
      throw error;
    }
    return Object.freeze({ kind: REVIEW_SHARED_EXCHANGE_PROFILE, applied, notificationsApplied: notificationMerge.added, idempotent: false, sourceSha256: manifest.sourceSha256, revision: updated.revision, manifestSha256: sha(entries.get('manifest.json')) });
  }
  exportReviewExchange(...args) { return this.export(...args); }
  importReviewExchange(...args) { return this.import(...args); }
}
export const ReviewSharedExchangeService = PdfReviewSharedExchangeService;
