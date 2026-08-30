import { validateReviewNotificationResult } from '../../contracts/local-host-review-notification-contract.js';
import { OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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

function requestValid(value, { read = false } = {}) {
  const hasActor = !read && value && Object.hasOwn(value, 'actorId');
  const keys = read ? ['sourceSha256', 'expectedRevision', 'notificationId']
    : (hasActor ? ['sourceSha256', 'expectedRevision', 'actorId'] : ['sourceSha256', 'expectedRevision']);
  if (!exact(value, keys) || !SHA256.test(value.sourceSha256 ?? '') || !revision(value.expectedRevision)) return false;
  return read
    ? ID.test(value.notificationId ?? '')
    : (!hasActor || REVIEWER.test(value.actorId));
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
