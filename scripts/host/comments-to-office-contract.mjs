import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { canonicalizeProjectBundle } from './project-bundle-framing.mjs';

export const COMMENTS_TO_OFFICE_PROFILE = 'local-comments-to-office-text-only-v1';
export const COMMENTS_TO_OFFICE_MAX_RECORDS = 500;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const STATUSES = new Set(['open', 'inProgress', 'accepted', 'rejected', 'resolved', 'custom']);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_COMMENTS_TO_OFFICE_REQUEST', `${label} must be a plain data record.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    fail('INVALID_COMMENTS_TO_OFFICE_REQUEST', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, label) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) {
    fail('COMMENTS_TO_OFFICE_UNTRUSTED_WORKSPACE', `${label} must be a dense data-only array.`, 502);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => key !== 'length'
    && (!Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) {
    fail('COMMENTS_TO_OFFICE_UNTRUSTED_WORKSPACE', `${label} must be a dense data-only array.`, 502);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail('COMMENTS_TO_OFFICE_FORGED_ID', `${label} must be a bounded opaque identifier.`, 400);
  return value;
}

function text(value, label, maximum = 10_000) {
  if (typeof value !== 'string' || value.length > maximum || value !== value.normalize('NFC')
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd\p{Cs}\p{Co}\p{Cn}]/u.test(value)) {
    fail('COMMENTS_TO_OFFICE_UNTRUSTED_WORKSPACE', `${label} must be bounded NFC text.`, 502);
  }
  if (EMAIL.test(value)) fail('COMMENTS_TO_OFFICE_PRIVATE_DATA', `${label} must not contain an email address.`, 422);
  return value;
}

function timestamp(value, label) {
  text(value, label, 64);
  if (Number.isNaN(Date.parse(value))) fail('COMMENTS_TO_OFFICE_UNTRUSTED_WORKSPACE', `${label} must be an ISO timestamp.`, 502);
  return value;
}

function reviewer(value) {
  if (typeof value !== 'string' || !REVIEWER.test(value)) {
    fail('COMMENTS_TO_OFFICE_AUTHOR_NOT_PSEUDONYMOUS', 'Comments-to-Office requires pseudonymous reviewer identifiers.', 422);
  }
  return value;
}

function selectedIds(value) {
  if (value === null) return null;
  denseArray(value, 'selectedIds');
  if (value.length < 1 || value.length > COMMENTS_TO_OFFICE_MAX_RECORDS) {
    fail('INVALID_COMMENTS_TO_OFFICE_REQUEST', 'selectedIds must be null or a non-empty bounded array.');
  }
  const normalized = value.map((item) => identifier(item, 'selected id'));
  if (new Set(normalized).size !== normalized.length) fail('COMMENTS_TO_OFFICE_FORGED_ID', 'selectedIds must be unique.');
  return Object.freeze(normalized);
}

export function normalizeCommentsToOfficeRequest(value) {
  const item = exact(value, ['sourceSha256', 'revision', 'selectedIds'], 'Comments-to-Office request');
  if (!SHA256.test(item.sourceSha256 ?? '')) fail('INVALID_COMMENTS_TO_OFFICE_REQUEST', 'sourceSha256 must be a lowercase SHA-256 digest.');
  if (!Number.isSafeInteger(item.revision) || item.revision < 0) fail('INVALID_COMMENTS_TO_OFFICE_REQUEST', 'revision must be a non-negative integer.');
  return Object.freeze({ sourceSha256: item.sourceSha256, revision: item.revision, selectedIds: selectedIds(item.selectedIds) });
}

function assertNoPrivatePayload(annotation) {
  if (['attachments', 'attachment', 'reference', 'html', 'email'].some((key) => annotation[key] != null)) {
    fail('COMMENTS_TO_OFFICE_PRIVATE_DATA', 'Attachments, references, HTML, and email fields are not exportable.', 422);
  }
}

function commentRecord(value, { annotationId, kind, page, order, status, timestampKey }) {
  identifier(value?.id, `${kind} id`);
  const normalizedStatus = status ?? value.status ?? 'open';
  if (!STATUSES.has(normalizedStatus)) fail('COMMENTS_TO_OFFICE_UNTRUSTED_WORKSPACE', 'Comment status is unsupported.', 502);
  return Object.freeze({
    id: value.id,
    annotationId,
    kind,
    page,
    order,
    authorId: reviewer(value.author),
    timestamp: timestamp(value[timestampKey], `${kind} timestamp`),
    status: normalizedStatus,
    text: text(value.text ?? '', `${kind} text`),
  });
}

function extractCurrentComments(snapshot) {
  const comments = [];
  const ids = new Set();
  for (const annotation of denseArray(snapshot?.namespaces?.annotations, 'annotations')) {
    assertNoPrivatePayload(annotation);
    identifier(annotation.id, 'annotation id');
    if (!Number.isSafeInteger(annotation.page) || annotation.page < 1 || annotation.page > 10_000) fail('COMMENTS_TO_OFFICE_UNTRUSTED_WORKSPACE', 'Annotation page is outside its bound.', 502);
    const records = [commentRecord(annotation, { annotationId: annotation.id, kind: 'annotation', page: annotation.page, order: comments.length + 1, timestampKey: 'createdAt' })];
    for (const reply of denseArray(annotation.replies ?? [], 'annotation replies')) records.push(commentRecord(reply, { annotationId: annotation.id, kind: 'comment', page: annotation.page, order: comments.length + records.length + 1, timestampKey: 'at' }));
    for (const record of records) {
      if (ids.has(record.id)) fail('COMMENTS_TO_OFFICE_FORGED_ID', 'Annotation and comment identifiers must be globally unique.', 409);
      ids.add(record.id); comments.push(record);
      if (comments.length > COMMENTS_TO_OFFICE_MAX_RECORDS) fail('COMMENTS_TO_OFFICE_LIMIT_EXCEEDED', 'The current comment set exceeds the export bound.', 413);
    }
  }
  return comments;
}

export function createCommentsToOfficeEnvelope(snapshot, { sourceSha256, revision, selectedIds }) {
  if (snapshot?.revision !== revision) fail('REVISION_CONFLICT', 'The workspace revision does not match the requested revision.', 409);
  const all = extractCurrentComments(snapshot);
  const selected = selectedIds === null ? all : (() => {
    const byId = new Map(all.map((record) => [record.id, record]));
    const records = selectedIds.map((recordId) => byId.get(recordId));
    if (records.some((record) => record === undefined)) fail('COMMENTS_TO_OFFICE_FORGED_ID', 'A selected annotation or comment identifier is not current.', 409);
    const wanted = new Set(selectedIds);
    return all.filter((record) => wanted.has(record.id));
  })();
  if (selected.length === 0) fail('COMMENTS_TO_OFFICE_EMPTY', 'No current comments were selected for export.', 422);
  const comments = Object.freeze([...selected]);
  const commentSha256 = createHash('sha256').update(canonicalizeProjectBundle(comments), 'utf8').digest('hex');
  return Object.freeze({ sourceSha256, revision, commentSha256, commentCount: comments.length, comments });
}
