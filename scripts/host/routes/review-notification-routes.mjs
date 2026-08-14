import { HostError } from '../host-error.mjs';
import { validateReviewNotificationResult } from '../../../src/core/local-host-review-notification-endpoints.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validActor(value) {
  return value === undefined || REVIEWER.test(value);
}

function validNotificationId(value) {
  return ID.test(value);
}

function invalidOptions(message = 'Review notification options are invalid.') {
  throw new HostError('INVALID_REVIEW_NOTIFICATION_OPTIONS', message, 400);
}

export async function handleReviewNotificationRoute(context) {
  const { operation } = context;
  if (operation !== 'review-notifications' && operation !== 'review-notification-read') return false;

  const {
    request, response, url, documentId, processing, store,
    reviewNotifications, bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Review notifications do not accept query parameters.', 400);
  const isRead = operation === 'review-notification-read';
  const methodName = isRead ? 'markRead' : 'generate';
  if (!reviewNotifications || typeof reviewNotifications[methodName] !== 'function') {
    throw new HostError('REVIEW_NOTIFICATIONS_UNAVAILABLE', 'Local review notifications are unavailable.', 503);
  }

  const body = await readJson(request, bodyLimit);
  const keys = isRead ? ['sourceSha256', 'expectedRevision', 'notificationId'] : ['sourceSha256', 'expectedRevision'];
  const hasActor = !isRead && body && Object.hasOwn(body, 'actorId');
  const expectedKeys = hasActor ? [...keys, 'actorId'] : keys;
  if (!exactJsonObject(body, expectedKeys)
    || !SHA256.test(body.sourceSha256 ?? '')
    || !validRevision(body.expectedRevision)
    || (!isRead && !validActor(body.actorId))
    || (isRead && !validNotificationId(body.notificationId))) {
    invalidOptions(isRead
      ? 'Marking a review notification read requires the current source SHA-256, workspace revision, and notification ID.'
      : 'Generating review notifications requires the current source SHA-256 and workspace revision.');
  }

  const document = store.getDocument(documentId);
  if (document.sha256 !== body.sourceSha256) {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'Review notification source digest does not match the current document.', 409);
  }

  const options = { expectedRevision: body.expectedRevision, signal: processing.signal };
  if (!isRead && hasActor) options.actorId = body.actorId;
  let result;
  if (isRead) result = await reviewNotifications.markRead(documentId, body.notificationId, options);
  else result = await reviewNotifications.generate(documentId, options);

  try {
    validateReviewNotificationResult(result, {
      documentId,
      sourceSha256: body.sourceSha256,
      expectedRevision: body.expectedRevision,
      operation: isRead ? 'markRead' : 'generate',
      request: isRead ? {
        sourceSha256: body.sourceSha256,
        expectedRevision: body.expectedRevision,
        notificationId: body.notificationId,
      } : undefined,
    });
  } catch (error) {
    throw new HostError('REVIEW_NOTIFICATION_RESULT_INVALID', 'The review notification service returned invalid source-bound evidence.', 502, { cause: error });
  }

  if (processing.signal.aborted || response.destroyed) return true;
  json(response, 200, { result });
  return true;
}

export const handleReviewNotificationsRoute = handleReviewNotificationRoute;
