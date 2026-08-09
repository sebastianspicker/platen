import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';

export const REVIEW_SIDECAR_STATUS_KIND = 'review-sidecar-status-v1';
export const REVIEW_SIDECAR_INSPECTION_KIND = 'review-sidecar-inspection-v1';
export const REVIEW_SIDECAR_LIMITS = Object.freeze({
  maxRevision: 1_000_000,
  maxSearchLength: 256,
  maxCustomStatusLength: 80,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STATUS = new Set(['open', 'inProgress', 'resolved', 'rejected', 'custom']);
const TYPE = new Set(['comment', 'note', 'callout', 'textMarkup', 'drawingMarkup', 'reference', 'measurement', 'stamp']);
const GROUP_BY = new Set(['none', 'status', 'type', 'author', 'page']);
const SORT_BY = new Set(['createdAt', 'page', 'status', 'type', 'author']);
const DIRECTION = new Set(['asc', 'desc']);
const DISALLOWED_TEXT = /[\u0000-\u001f\u007f\ufffd\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 1_000;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 10_000;

function fail(message) { throw new HostError('INVALID_REVIEW_SIDECAR_REQUEST', message, 400); }

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true)) {
    fail(`${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function boundedText(value, label, maximum, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || value !== value.normalize('NFC')
    || DISALLOWED_TEXT.test(value) || (required && !value.trim())) {
    fail(`${label} must be bounded NFC text.`);
  }
  return value;
}

function digest(value) { if (typeof value !== 'string' || !SHA256.test(value)) fail('sourceSha256 must be a lowercase SHA-256 digest.'); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0 || value > REVIEW_SIDECAR_LIMITS.maxRevision) fail('expectedRevision must be a bounded non-negative integer.'); return value; }
function annotationId(value) { if (typeof value !== 'string' || !ID.test(value)) fail('annotationId must be a bounded identifier.'); return value; }
function status(value) { if (!STATUS.has(value)) fail('status is unsupported.'); return value; }

function normalizeStatusFields(value) {
  const item = exact(value, ['sourceSha256', 'expectedRevision', 'annotationId', 'status', 'customStatus'], 'review sidecar status request');
  digest(item.sourceSha256); revision(item.expectedRevision); annotationId(item.annotationId); status(item.status);
  if (item.status === 'custom') boundedText(item.customStatus, 'customStatus', REVIEW_SIDECAR_LIMITS.maxCustomStatusLength, { required: true });
  else if (item.customStatus !== null) fail('customStatus must be null unless status is custom.');
  return Object.freeze(item);
}

function normalizeQuery(value) {
  const item = exact(value, ['search', 'status', 'type', 'groupBy', 'sortBy', 'direction'], 'review sidecar query');
  boundedText(item.search, 'query.search', REVIEW_SIDECAR_LIMITS.maxSearchLength);
  if (item.status !== null && !STATUS.has(item.status)) fail('query.status is unsupported.');
  if (item.type !== null && !TYPE.has(item.type)) fail('query.type is unsupported.');
  if (!GROUP_BY.has(item.groupBy) || !SORT_BY.has(item.sortBy) || !DIRECTION.has(item.direction)) fail('query grouping or sorting is unsupported.');
  return Object.freeze(item);
}

export function normalizeReviewSidecarStatusRequest(value) { return normalizeStatusFields(value); }

export function normalizeReviewSidecarInspectionRequest(value) {
  const item = exact(value, ['sourceSha256', 'expectedRevision', 'query'], 'review sidecar inspection request');
  return Object.freeze({ sourceSha256: digest(item.sourceSha256), expectedRevision: revision(item.expectedRevision), query: normalizeQuery(item.query) });
}

function resultExact(value, keys, label) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain data object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true)) {
    throw new TypeError(`${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function resultData(value, label, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError(`${label} is too deeply nested.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new TypeError(`${label} contains an overlong string.`);
    return value;
  }
  if (!value || typeof value !== 'object' || isProxy(value)) throw new TypeError(`${label} must be JSON data.`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_LENGTH
      || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) {
      throw new TypeError(`${label} must be a bounded dense data array.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => key !== 'length'
      && (!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
        || descriptors[key].enumerable !== true))) throw new TypeError(`${label} contains an accessor.`);
    return value.map((_, index) => resultData(descriptors[String(index)].value, `${label}[${index}]`, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain data object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_OBJECT_KEYS || keys.some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) throw new TypeError(`${label} contains an accessor, symbol, or unsupported field.`);
  return Object.fromEntries(keys.map((key) => [key, resultData(descriptors[key].value, `${label}.${key}`, depth + 1)]));
}

function resultText(value, label, maximum = MAX_STRING_LENGTH, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || value !== value.normalize('NFC')
    || DISALLOWED_TEXT.test(value) || (required && !value.trim())) throw new TypeError(`${label} is invalid.`);
  return value;
}

function resultId(value, label) { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${label} is invalid.`); return value; }
function resultRevision(value, label) { if (!Number.isSafeInteger(value) || value < 0 || value > REVIEW_SIDECAR_LIMITS.maxRevision) throw new TypeError(`${label} is invalid.`); return value; }
function resultDigest(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} is invalid.`); return value; }

function annotationResult(value, label) {
  const optional = ['customStatus', 'reference', 'measurement', 'stamp'].filter((key) => Object.hasOwn(value, key));
  const record = resultExact(value, ['id', 'prototypeSidecar', 'type', 'page', 'rectangle', 'text', 'author', 'status', 'properties', 'mentions', 'createdAt', 'replies', ...optional], label);
  resultId(record.id, `${label}.id`);
  if (record.prototypeSidecar !== true || !TYPE.has(record.type) || !Number.isSafeInteger(record.page)
    || record.page < 1 || record.page > 10_000 || !Array.isArray(record.rectangle)
    || record.rectangle.length !== 4 || record.rectangle.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new TypeError(`${label} is not a retained local annotation.`);
  }
  resultText(record.text, `${label}.text`, 4_000); resultText(record.author, `${label}.author`, 128);
  if (!STATUS.has(record.status)) throw new TypeError(`${label}.status is invalid.`);
  if (record.status === 'custom') resultText(record.customStatus, `${label}.customStatus`, REVIEW_SIDECAR_LIMITS.maxCustomStatusLength, { required: true });
  else if (Object.hasOwn(record, 'customStatus') && record.customStatus !== null) throw new TypeError(`${label}.customStatus is invalid.`);
  const properties = resultData(record.properties, `${label}.properties`);
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 24
    || Object.entries(properties).some(([key, item]) => !ID.test(key) || typeof item !== 'string' || item.length > 500)) throw new TypeError(`${label}.properties is invalid.`);
  const mentions = resultData(record.mentions, `${label}.mentions`);
  if (!Array.isArray(mentions) || mentions.length > 32 || mentions.some((item) => typeof item !== 'string' || !item.trim() || item.length > 128)) throw new TypeError(`${label}.mentions is invalid.`);
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) throw new TypeError(`${label}.createdAt is invalid.`);
  const replies = resultData(record.replies, `${label}.replies`);
  if (!Array.isArray(replies) || replies.length > 64 || replies.some((reply, index) => {
    try {
      const item = resultExact(reply, ['id', 'text', 'author', 'at'], `${label}.replies[${index}]`);
      resultId(item.id, `${label}.replies[${index}].id`); resultText(item.text, `${label}.replies[${index}].text`, 4_000, { required: true });
      resultText(item.author, `${label}.replies[${index}].author`, 128, { required: true });
      return typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at));
    } catch { return true; }
  })) throw new TypeError(`${label}.replies is invalid.`);
  if (Object.hasOwn(record, 'reference')) {
    const reference = resultExact(record.reference, ['kind', 'label', 'mimeType'], `${label}.reference`);
    if (!['file', 'audio'].includes(reference.kind)) throw new TypeError(`${label}.reference is invalid.`);
    resultText(reference.label, `${label}.reference.label`, 256, { required: true }); resultText(reference.mimeType, `${label}.reference.mimeType`, 128);
  }
  if (Object.hasOwn(record, 'measurement')) {
    const measurement = resultExact(record.measurement, ['value', 'unit'], `${label}.measurement`);
    if (typeof measurement.value !== 'number' || !Number.isFinite(measurement.value) || Math.abs(measurement.value) > 1_000_000) throw new TypeError(`${label}.measurement is invalid.`);
    resultText(measurement.unit, `${label}.measurement.unit`, 32, { required: true });
  }
  if (Object.hasOwn(record, 'stamp')) resultText(record.stamp, `${label}.stamp`, 128, { required: true });
  return record;
}

function annotationsResult(value) {
  const groups = resultData(value, 'annotationsOrGroups');
  if (Array.isArray(groups)) return groups.map((record, index) => annotationResult(record, `annotationsOrGroups[${index}]`));
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new TypeError('annotationsOrGroups must be annotations or grouped annotations.');
  return Object.fromEntries(Object.entries(groups).map(([group, records]) => {
    resultText(group, 'annotationsOrGroups group', 256);
    if (!Array.isArray(records)) throw new TypeError('annotationsOrGroups group must contain an array.');
    return [group, records.map((record, index) => annotationResult(record, `annotationsOrGroups.${group}[${index}]`))];
  }));
}

function commentSummaryResult(value) {
  const entries = resultData(value, 'commentSummary');
  if (!Array.isArray(entries)) throw new TypeError('commentSummary must be an array.');
  return entries.map((entry, index) => {
    const item = resultExact(entry, ['id', 'status', 'replies', 'text'], `commentSummary[${index}]`);
    resultId(item.id, `commentSummary[${index}].id`);
    resultText(item.status, `commentSummary[${index}].status`, REVIEW_SIDECAR_LIMITS.maxCustomStatusLength, { required: true });
    if (!Number.isSafeInteger(item.replies) || item.replies < 0 || item.replies > MAX_ARRAY_LENGTH) throw new TypeError(`commentSummary[${index}].replies is invalid.`);
    resultText(item.text, `commentSummary[${index}].text`);
    return item;
  });
}

function activityResult(value) {
  const records = resultData(value, 'activity');
  if (!Array.isArray(records)) throw new TypeError('activity must be an array.');
  return records.map((record, index) => {
    const item = resultExact(record, ['id', 'kind', 'annotationId', 'activity', 'actor', 'detail', 'at'], `activity[${index}]`);
    resultId(item.id, `activity[${index}].id`); resultId(item.annotationId, `activity[${index}].annotationId`);
    if (item.kind !== 'activity') throw new TypeError('activity must contain retained activity records only.');
    resultText(item.activity, `activity[${index}].activity`, 64, { required: true });
    resultText(item.actor, `activity[${index}].actor`, 128); resultText(item.detail, `activity[${index}].detail`, 500);
    if (typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) throw new TypeError(`activity[${index}].at is invalid.`);
    return item;
  });
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function freezeReviewSidecarResult(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Review sidecar result must be a plain data object.');
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) throw new TypeError('Review sidecar result kind is invalid.');
  if (kindDescriptor.value === REVIEW_SIDECAR_STATUS_KIND) {
    const envelope = resultExact(value, ['kind', 'sourceDigest', 'revision', 'annotationId', 'status', 'customStatus', 'localOnly'], 'review sidecar status result');
    resultDigest(envelope.sourceDigest, 'sourceDigest'); resultRevision(envelope.revision, 'revision'); resultId(envelope.annotationId, 'annotationId');
    if (!STATUS.has(envelope.status) || envelope.localOnly !== true) throw new TypeError('Review sidecar status result is invalid.');
    if (envelope.status === 'custom') resultText(envelope.customStatus, 'customStatus', REVIEW_SIDECAR_LIMITS.maxCustomStatusLength, { required: true });
    else if (envelope.customStatus !== null) throw new TypeError('customStatus must be null unless status is custom.');
    return freeze(envelope);
  }
  const inspection = resultExact(value, ['kind', 'sourceDigest', 'revision', 'annotationsOrGroups', 'count', 'commentSummary', 'activity', 'limitations', 'localOnly'], 'review sidecar inspection result');
  if (inspection.kind !== REVIEW_SIDECAR_INSPECTION_KIND || inspection.localOnly !== true) throw new TypeError('Review sidecar inspection result is invalid.');
  resultDigest(inspection.sourceDigest, 'sourceDigest'); resultRevision(inspection.revision, 'revision');
  const annotationsOrGroups = annotationsResult(inspection.annotationsOrGroups);
  const count = Array.isArray(annotationsOrGroups) ? annotationsOrGroups.length : Object.values(annotationsOrGroups).reduce((sum, group) => sum + group.length, 0);
  if (inspection.count !== count) throw new TypeError('Review sidecar inspection count does not match its annotations.');
  const commentSummary = commentSummaryResult(inspection.commentSummary);
  const activity = activityResult(inspection.activity);
  const limitations = resultData(inspection.limitations, 'limitations');
  if (!Array.isArray(limitations) || limitations.length !== 1 || limitations[0] !== 'Local session sidecar only; no PDF annotations are read or written.') throw new TypeError('Review sidecar inspection limitations are invalid.');
  return freeze({ ...inspection, annotationsOrGroups, commentSummary, activity, limitations });
}
