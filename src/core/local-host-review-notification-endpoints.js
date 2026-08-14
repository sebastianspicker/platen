import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_EVENTS = 500;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function optionsValid(options) {
  const keys = options?.signal === undefined ? [] : ['signal'];
  return exact(options, keys) && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function revision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalid() {
  throw new TypeError('The local host returned an invalid review notification result.');
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function requestValid(value, { read = false } = {}) {
  const hasActor = !read && value && Object.hasOwn(value, 'actorId');
  const keys = read ? ['sourceSha256', 'expectedRevision', 'notificationId']
    : (hasActor ? ['sourceSha256', 'expectedRevision', 'actorId'] : ['sourceSha256', 'expectedRevision']);
  if (!exact(value, keys) || !SHA256.test(value.sourceSha256 ?? '') || !revision(value.expectedRevision)) return false;
  return read
    ? ID.test(value.notificationId ?? '')
    : (!hasActor || REVIEWER.test(value.actorId));
}

export function validateReviewNotificationResult(result, {
  sourceSha256, expectedRevision, operation = 'generate', request = null,
} = {}) {
  const read = operation === 'markRead';
  const expectedRequest = request ?? (read
    ? { sourceSha256, expectedRevision, notificationId: result?.notificationId }
    : { sourceSha256, expectedRevision });
  if (!requestValid(expectedRequest, { read }) || expectedRequest.sourceSha256 !== sourceSha256
    || expectedRequest.expectedRevision !== expectedRevision) invalid();
  const keys = read ? ['changed', 'idempotent', 'revision', 'sourceSha256'] : ['applied', 'idempotent', 'revision', 'sourceSha256'];
  if (!exact(result, keys) || result.sourceSha256 !== sourceSha256 || !revision(result.revision)
    || result.revision < expectedRevision || typeof result.idempotent !== 'boolean') invalid();
  if (read) {
    if (typeof result.changed !== 'boolean' || result.idempotent !== !result.changed) invalid();
  } else if (!Number.isSafeInteger(result.applied) || result.applied < 0 || result.applied > MAX_EVENTS
    || result.idempotent !== (result.applied === 0)) invalid();
  return frozen(structuredClone(result));
}

function normalizeGenerateRequest(value) {
  const hasActor = value && Object.hasOwn(value, 'actorId');
  const keys = hasActor ? ['sourceSha256', 'expectedRevision', 'actorId'] : ['sourceSha256', 'expectedRevision'];
  if (!exact(value, keys) || !SHA256.test(value.sourceSha256 ?? '') || !revision(value.expectedRevision)
    || (hasActor && !REVIEWER.test(value.actorId))) throw new TypeError('Review notification options are invalid.');
  return Object.freeze({ ...value });
}

function normalizeReadRequest(sourceSha256, expectedRevision, notificationId) {
  const request = { sourceSha256, expectedRevision, notificationId };
  if (!requestValid(request, { read: true })) throw new TypeError('Review notification read options are invalid.');
  return Object.freeze(request);
}

export function createReviewNotificationEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Review notification endpoints require a JSON transport.');

  function generateReviewNotifications(documentId, requestInput, options = {}) {
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !optionsValid(options)) throw new TypeError('Review notification options are invalid.');
    const request = normalizeGenerateRequest(requestInput);
    return postJson(json, documentEndpointPath(documentId, '/review-notifications'), request, options.signal)
      .then((body) => validateReviewNotificationResult(body?.result, {
        documentId, sourceSha256: request.sourceSha256, expectedRevision: request.expectedRevision,
        operation: 'generate', request,
      }));
  }

  function markReviewNotificationRead(documentId, requestInput, options = {}) {
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !optionsValid(options)) throw new TypeError('Review notification read options are invalid.');
    const request = normalizeReadRequest(requestInput?.sourceSha256, requestInput?.expectedRevision, requestInput?.notificationId);
    if (!exact(requestInput, ['sourceSha256', 'expectedRevision', 'notificationId'])) throw new TypeError('Review notification read options are invalid.');
    return postJson(json, documentEndpointPath(documentId, '/review-notification-read'), request, options.signal)
      .then((body) => validateReviewNotificationResult(body?.result, {
        documentId, sourceSha256: request.sourceSha256, expectedRevision: request.expectedRevision,
        operation: 'markRead', request,
      }));
  }

  return Object.freeze({ generateReviewNotifications, markReviewNotificationRead });
}
