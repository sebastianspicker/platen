import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const REVIEW_SIDECAR_STATUS_KIND = 'review-sidecar-status-v1';
export const REVIEW_SIDECAR_INSPECTION_KIND = 'review-sidecar-inspection-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const DISALLOWED_TEXT = /[\u0000-\u001f\u007f\ufffd\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STATUSES = ['open', 'inProgress', 'resolved', 'rejected', 'custom'];
const TYPES = ['comment', 'note', 'callout', 'textMarkup', 'drawingMarkup', 'reference', 'measurement', 'stamp'];
const GROUPS = ['none', 'status', 'type', 'author', 'page'];
const SORTS = ['createdAt', 'page', 'status', 'type', 'author'];
const DIRECTIONS = ['asc', 'desc'];
const LIMITATIONS = ['Local session sidecar only; no PDF annotations are read or written.'];

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(value);
    const valid = own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
    if (!valid) return false;
    try { structuredClone(value); } catch { return false; }
    return true;
  } catch { return false; }
}

function dense(value, minimum = 0, maximum = 500) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Array.from({ length: value.length }, (_, index) => descriptors[index]).every((descriptor) => descriptor
      && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
  } catch { return false; }
}

function printable(value, maximum, { required = false } = {}) {
  return typeof value === 'string' && value.length <= maximum && value.normalize('NFC') === value
    && !DISALLOWED_TEXT.test(value) && (!required || value.trim().length > 0);
}

function revision(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000; }

function optionsSignal(options) {
  const keys = options?.signal === undefined ? [] : ['signal'];
  if (!exact(options, keys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Review sidecar options are invalid.');
  return options.signal;
}

function validStatusRequest(value) {
  return exact(value, ['sourceSha256', 'expectedRevision', 'annotationId', 'status', 'customStatus'])
    && SHA256.test(value.sourceSha256 ?? '') && revision(value.expectedRevision) && ID.test(value.annotationId ?? '')
    && STATUSES.includes(value.status) && (value.status === 'custom'
      ? printable(value.customStatus, 80, { required: true }) : value.customStatus === null);
}

function validQuery(value) {
  return exact(value, ['search', 'status', 'type', 'groupBy', 'sortBy', 'direction'])
    && printable(value.search, 256) && (value.status === null || STATUSES.includes(value.status))
    && (value.type === null || TYPES.includes(value.type)) && GROUPS.includes(value.groupBy)
    && SORTS.includes(value.sortBy) && DIRECTIONS.includes(value.direction);
}

function validInspectionRequest(value) {
  return exact(value, ['sourceSha256', 'expectedRevision', 'query'])
    && SHA256.test(value.sourceSha256 ?? '') && revision(value.expectedRevision) && validQuery(value.query);
}

function validRectangle(value) {
  return dense(value, 4, 4) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function validAnnotation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const optional = Object.hasOwn(value, 'reference') ? ['reference'] : [];
  if (Object.hasOwn(value, 'measurement')) optional.push('measurement');
  if (Object.hasOwn(value, 'stamp')) optional.push('stamp');
  const keys = ['id', 'prototypeSidecar', 'type', 'page', 'rectangle', 'text', 'author', 'status', 'properties', 'mentions', 'createdAt', 'replies', ...(Object.hasOwn(value, 'customStatus') ? ['customStatus'] : []), ...optional];
  if (!exact(value, keys) || !ID.test(value.id ?? '') || value.prototypeSidecar !== true || !TYPES.includes(value.type)
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 10_000 || !validRectangle(value.rectangle)
    || !printable(value.text, 4_000) || !printable(value.author, 128) || !STATUSES.includes(value.status)
    || !(value.status === 'custom' ? Object.hasOwn(value, 'customStatus') && printable(value.customStatus, 80, { required: true }) : !Object.hasOwn(value, 'customStatus') || value.customStatus === null)
    || !exact(value.properties, Object.keys(value.properties)) || Reflect.ownKeys(value.properties).length > 24
    || Object.entries(value.properties).some(([key, item]) => !ID.test(key) || !printable(item, 500))
    || !dense(value.mentions, 0, 32) || value.mentions.some((item) => !printable(item, 128, { required: true }))
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || !dense(value.replies, 0, 64)) return false;
  if (value.replies.some((reply) => !exact(reply, ['id', 'text', 'author', 'at']) || !ID.test(reply.id ?? '')
    || !printable(reply.text, 4_000, { required: true }) || !printable(reply.author, 128, { required: true })
    || typeof reply.at !== 'string' || Number.isNaN(Date.parse(reply.at)))) return false;
  if (Object.hasOwn(value, 'stamp') && !printable(value.stamp, 128, { required: true })) return false;
  if (Object.hasOwn(value, 'reference') && (!exact(value.reference, ['kind', 'label', 'mimeType'])
    || !['file', 'audio'].includes(value.reference.kind) || !printable(value.reference.label, 256, { required: true })
    || !printable(value.reference.mimeType, 128))) return false;
  if (Object.hasOwn(value, 'measurement') && (!exact(value.measurement, ['value', 'unit'])
    || typeof value.measurement.value !== 'number' || !Number.isFinite(value.measurement.value)
    || Math.abs(value.measurement.value) > 1_000_000 || !printable(value.measurement.unit, 32, { required: true }))) return false;
  return true;
}

function validGroups(value) {
  if (dense(value)) return value.every(validAnnotation);
  if (!exact(value, Object.keys(value)) || Reflect.ownKeys(value).length > 250) return false;
  return Object.entries(value).every(([key, list]) => printable(key, 128) && dense(list) && list.every(validAnnotation));
}

function validActivity(value) {
  return dense(value) && value.every((entry) => exact(entry, ['id', 'kind', 'annotationId', 'activity', 'actor', 'detail', 'at'])
    && ID.test(entry.id ?? '') && entry.kind === 'activity' && ID.test(entry.annotationId ?? '')
    && printable(entry.activity, 64, { required: true }) && printable(entry.actor, 128)
    && printable(entry.detail, 500) && typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)));
}

function validInspectionResult(result, request) {
  const count = dense(result?.annotationsOrGroups)
    ? result.annotationsOrGroups.length
    : (result?.annotationsOrGroups && typeof result.annotationsOrGroups === 'object'
      ? Object.values(result.annotationsOrGroups).reduce((total, group) => total + (Array.isArray(group) ? group.length : 0), 0) : -1);
  return exact(result, ['kind', 'sourceDigest', 'revision', 'annotationsOrGroups', 'count', 'commentSummary', 'activity', 'limitations', 'localOnly'])
    && result.kind === REVIEW_SIDECAR_INSPECTION_KIND && result.sourceDigest === request.sourceSha256
    && revision(result.revision) && result.revision === request.expectedRevision && validGroups(result.annotationsOrGroups)
    && Number.isSafeInteger(result.count) && result.count === count && result.count >= 0 && result.count <= 500
    && dense(result.commentSummary) && result.commentSummary.every((entry) => exact(entry, ['id', 'status', 'replies', 'text'])
      && ID.test(entry.id ?? '') && printable(entry.status, 80, { required: true }) && Number.isSafeInteger(entry.replies) && entry.replies >= 0 && entry.replies <= 64
      && printable(entry.text, 4_000)) && validActivity(result.activity) && dense(result.limitations, 1, 1)
    && result.limitations[0] === LIMITATIONS[0] && result.localOnly === true;
}

function invalid(message) { throw new TypeError(message); }

function validatedResult(result, valid, message) {
  if (!valid) invalid(message);
  let clone;
  try { clone = structuredClone(result); } catch { invalid(message); }
  return deepFreeze(clone);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateReviewSidecarStatusResult(result, request) {
  if (!validStatusRequest(request) || !exact(result, ['kind', 'sourceDigest', 'revision', 'annotationId', 'status', 'customStatus', 'localOnly'])
    || result.kind !== REVIEW_SIDECAR_STATUS_KIND || result.sourceDigest !== request.sourceSha256 || !Number.isSafeInteger(result.revision)
    || result.revision !== request.expectedRevision + 1 || result.annotationId !== request.annotationId || result.status !== request.status
    || result.customStatus !== request.customStatus || result.localOnly !== true) invalid('The local host returned an invalid review sidecar status result.');
  return validatedResult(result, true, 'The local host returned an invalid review sidecar status result.');
}

export function validateReviewSidecarInspectionResult(result, request) {
  return validatedResult(result, validInspectionResult(result, request), 'The local host returned an invalid review sidecar inspection result.');
}

export function createReviewSidecarEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Review sidecar endpoints require a JSON transport.');
  function setReviewSidecarStatus(documentId, request, options = {}) {
    const signal = optionsSignal(options);
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validStatusRequest(request)) invalid('Review sidecar status options are invalid.');
    return postJson(json, documentEndpointPath(documentId, '/review-sidecar-status'), request, signal)
      .then((body) => validateReviewSidecarStatusResult(body?.result, request));
  }
  function inspectReviewSidecar(documentId, request, options = {}) {
    const signal = optionsSignal(options);
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validInspectionRequest(request)) invalid('Review sidecar inspection options are invalid.');
    return postJson(json, documentEndpointPath(documentId, '/review-sidecar-inspect'), request, signal)
      .then((body) => validateReviewSidecarInspectionResult(body?.result, request));
  }
  return Object.freeze({ setReviewSidecarStatus, inspectReviewSidecar });
}
