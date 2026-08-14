import { HostError } from './host-error.mjs';
import { isProxy } from 'node:util/types';
import { createReviewNotification, parseReviewNotification, validateReviewMention } from './pdf-review-notifications-contract.mjs';

const MAX_EVENTS = 500;
function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Review notification processing was cancelled.', 499); }
function dataArray(value, label) { if (!Array.isArray(value) || isProxy(value) || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length || Object.getPrototypeOf(value) !== Array.prototype) fail('INVALID_REVIEW_NOTIFICATION', `${label} must be a dense data-only array.`); const descriptors = Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(value).some((key) => key !== 'length' && (!Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) fail('INVALID_REVIEW_NOTIFICATION', `${label} must be a dense data-only array.`); return value; }
function mentionList(value, label) { return dataArray(value ?? [], label).map((item) => validateReviewMention(item, label)); }
function isNotificationRecord(record, idValue = null) { if (!record || typeof record !== 'object' || isProxy(record)) return false; const descriptors = Object.getOwnPropertyDescriptors(record); const type = descriptors.type; const id = descriptors.id; return Boolean(type && Object.hasOwn(type, 'value') && type.value === 'mention-notification' && (!idValue || id && Object.hasOwn(id, 'value') && id.value === idValue)); }
function collect(snapshot, { sourceSha256, revision, actorId }) {
  const events = []; for (const annotation of dataArray(snapshot.namespaces.annotations, 'annotations')) { for (const mentionedReviewer of mentionList(annotation.mentions, 'annotation mentions')) events.push(createReviewNotification({ sourceSha256, workspaceRevision: revision, annotationId: annotation.id, mentionedReviewer, actorId: actorId ?? annotation.author, timestamp: annotation.createdAt })); for (const reply of dataArray(annotation.replies ?? [], 'replies')) for (const mentionedReviewer of mentionList(reply.mentions, 'comment mentions')) events.push(createReviewNotification({ sourceSha256, workspaceRevision: revision, annotationId: annotation.id, commentId: reply.id, mentionedReviewer, actorId: actorId ?? reply.author, timestamp: reply.at })); }
  return events;
}
function mergeNotifications(snapshot, events, sourceSha256) {
  const records = dataArray(snapshot.namespaces.reviewRecords, 'reviewRecords').slice(); const byEvent = new Map(); for (const record of records) if (isNotificationRecord(record)) { const parsed = parseReviewNotification(record); byEvent.set(parsed.eventId, parsed); }
  let added = 0; for (const event of events) { const existing = byEvent.get(event.eventId); if (existing) { const { status: _existingStatus, workspaceRevision: _existingRevision, ...comparableExisting } = existing; const { status: _eventStatus, workspaceRevision: _eventRevision, ...comparableEvent } = event; if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableEvent)) fail('REVIEW_NOTIFICATION_CONFLICT', 'A notification event has conflicting immutable content.', 409); continue; } if (byEvent.size >= MAX_EVENTS) fail('REVIEW_NOTIFICATION_LIMIT', 'The local notification inbox is full.', 413); records.push(event); byEvent.set(event.eventId, event); added += 1; }
  return { records, added };
}

export class PdfReviewNotificationsService {
  #documents; #workspace;
  constructor({ documents, workspace } = {}) { if (!documents || typeof documents.getDocument !== 'function' || typeof documents.verifySource !== 'function' || !workspace || typeof workspace.snapshot !== 'function' || typeof workspace.replaceSnapshot !== 'function') throw new TypeError('PdfReviewNotificationsService requires document and workspace stores.'); this.#documents = documents; this.#workspace = workspace; }
  async generate(documentId, { actorId, expectedRevision, signal } = {}) {
    abort(signal);
    const document = this.#documents.getDocument(documentId); const snapshot = this.#workspace.snapshot(documentId);
    if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) fail('REVISION_CONFLICT', 'Workspace revision does not match the notification request.', 409);
    const events = collect(snapshot, { sourceSha256: document.sha256, revision: snapshot.revision, actorId });
    await this.#documents.verifySource(documentId); abort(signal);
    const current = this.#documents.getDocument(documentId); if (current.sha256 !== document.sha256) fail('REVIEW_NOTIFICATION_SOURCE_MISMATCH', 'Source PDF changed while generating notifications.', 409);
    const merged = mergeNotifications(snapshot, events, document.sha256); if (!merged.added) return Object.freeze({ applied: 0, idempotent: true, revision: snapshot.revision, sourceSha256: document.sha256 });
    abort(signal); const replacement = { documentId, revision: snapshot.revision, namespaces: { ...snapshot.namespaces, reviewRecords: merged.records }, audit: snapshot.audit }; let updated;
    try { updated = this.#workspace.replaceSnapshot(documentId, replacement, { expectedRevision: snapshot.revision }); } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT') throw error; const latest = this.#workspace.snapshot(documentId); const replay = mergeNotifications(latest, events, document.sha256);
      if (!replay.added) return Object.freeze({ applied: 0, idempotent: true, revision: latest.revision, sourceSha256: document.sha256 }); throw error;
    }
    return Object.freeze({ applied: merged.added, idempotent: false, revision: updated.revision, sourceSha256: document.sha256 });
  }
  async markRead(documentId, notificationId, { expectedRevision, signal } = {}) {
    abort(signal); const document = this.#documents.getDocument(documentId); const snapshot = this.#workspace.snapshot(documentId);
    if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) fail('REVISION_CONFLICT', 'Workspace revision does not match the notification request.', 409);
    const records = dataArray(snapshot.namespaces.reviewRecords, 'reviewRecords').slice(); const index = records.findIndex((record) => isNotificationRecord(record, notificationId));
    if (index < 0) fail('NOTIFICATION_NOT_FOUND', 'The local notification was not found.', 404); const notification = parseReviewNotification(records[index]);
    if (notification.status === 'read') return Object.freeze({ changed: false, idempotent: true, revision: snapshot.revision, sourceSha256: document.sha256 });
    records[index] = { ...notification, status: 'read' }; await this.#documents.verifySource(documentId); abort(signal);
    const current = this.#documents.getDocument(documentId); if (current.sha256 !== document.sha256) fail('REVIEW_NOTIFICATION_SOURCE_MISMATCH', 'Source PDF changed while marking the notification.', 409);
    let updated; try {
      updated = this.#workspace.replaceSnapshot(documentId, { documentId, revision: snapshot.revision, namespaces: { ...snapshot.namespaces, reviewRecords: records }, audit: snapshot.audit }, { expectedRevision: snapshot.revision });
    } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT') throw error;
      const latest = this.#workspace.snapshot(documentId); const latestRecord = dataArray(latest.namespaces.reviewRecords, 'reviewRecords').find((record) => isNotificationRecord(record, notificationId));
      if (latestRecord && parseReviewNotification(latestRecord).status === 'read') return Object.freeze({ changed: false, idempotent: true, revision: latest.revision, sourceSha256: document.sha256 });
      throw error;
    }
    return Object.freeze({ changed: true, idempotent: false, revision: updated.revision, sourceSha256: document.sha256 });
  }
}
export const ReviewNotificationsService = PdfReviewNotificationsService;
export { collect as collectReviewMentionNotifications, mergeNotifications as mergeReviewNotifications };
