import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { canonicalizeProjectBundle } from './project-bundle-framing.mjs';

export const REVIEW_NOTIFICATION_SCHEMA_VERSION = 1;
export const REVIEW_NOTIFICATION_MAX_EVENTS = 500;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
function fail(message, code = 'INVALID_REVIEW_NOTIFICATION') { throw new HostError(code, message, 400); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || Reflect.ownKeys(value).some((key) => typeof key !== 'string') || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) fail(`${label} contains unsupported fields or accessors.`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function text(value, label, max = 128) { if (typeof value !== 'string' || value.length > max || value !== value.normalize('NFC') || /[\u0000-\u001f\u007f\ufffd\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) fail(`${label} must be bounded NFC text.`); return value; }
function reviewer(value, label) { if (typeof value !== 'string' || !REVIEWER.test(value)) fail(`${label} must be a pseudonymous reviewer ID.`); return value; }
function digest(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest.`); return value; }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(`${label} must be a bounded identifier.`); return value; }
function integer(value, label) { if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer.`); return value; }
function timestamp(value) { text(value, 'timestamp', 64); if (Number.isNaN(Date.parse(value))) fail('timestamp must be an ISO timestamp.'); return value; }
export function validateReviewMention(value, label = 'mentionedReviewer') { return reviewer(value, label); }
export function notificationEventId({ sourceSha256, annotationId, commentId, mentionedReviewer, timestamp: at }) { digest(sourceSha256, 'sourceSha256'); id(annotationId, 'annotationId'); if (commentId !== null) id(commentId, 'commentId'); reviewer(mentionedReviewer, 'mentionedReviewer'); timestamp(at); return createHash('sha256').update(canonicalizeProjectBundle({ schemaVersion: REVIEW_NOTIFICATION_SCHEMA_VERSION, sourceSha256, annotationId, commentId, mentionedReviewer, timestamp: at }), 'utf8').digest('hex'); }
export function parseReviewNotification(value) {
  const item = exact(value, ['actorId', 'annotationId', 'commentId', 'eventId', 'id', 'mentionedReviewer', 'sourceSha256', 'status', 'summarySha256', 'timestamp', 'type', 'workspaceRevision'], 'notification');
  if (item.type !== 'mention-notification' || item.status !== 'unread' && item.status !== 'read') fail('Notification type or status is unsupported.');
  id(item.id, 'notification id'); id(item.annotationId, 'annotationId'); if (item.commentId !== null) id(item.commentId, 'commentId'); digest(item.sourceSha256, 'sourceSha256'); reviewer(item.actorId, 'actorId'); reviewer(item.mentionedReviewer, 'mentionedReviewer'); digest(item.eventId, 'eventId'); digest(item.summarySha256, 'summarySha256'); integer(item.workspaceRevision, 'workspaceRevision'); timestamp(item.timestamp);
  if (notificationEventId({ sourceSha256: item.sourceSha256, annotationId: item.annotationId, commentId: item.commentId, mentionedReviewer: item.mentionedReviewer, timestamp: item.timestamp }) !== item.eventId) fail('Notification event ID does not match its immutable fields.');
  const summarySha256 = createHash('sha256').update(canonicalizeProjectBundle({ eventId: item.eventId, actorId: item.actorId, mentionedReviewer: item.mentionedReviewer }), 'utf8').digest('hex');
  if (summarySha256 !== item.summarySha256) fail('Notification summary digest does not match its immutable fields.');
  return Object.freeze(item);
}
export function createReviewNotification({ sourceSha256, workspaceRevision, annotationId, commentId = null, mentionedReviewer, actorId, timestamp: at }) {
  const eventId = notificationEventId({ sourceSha256, annotationId, commentId, mentionedReviewer, timestamp: at }); reviewer(actorId, 'actorId'); const summarySha256 = createHash('sha256').update(canonicalizeProjectBundle({ eventId, actorId, mentionedReviewer }), 'utf8').digest('hex');
  return parseReviewNotification({ id: `notification-${eventId}`, type: 'mention-notification', sourceSha256, workspaceRevision, eventId, annotationId, commentId, mentionedReviewer, actorId, timestamp: at, status: 'unread', summarySha256 });
}
