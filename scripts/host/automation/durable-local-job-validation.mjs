import { isSafeQueueName, queueFail } from './durable-local-job-record.mjs';

export function validateQueueRequest(runtime, type, idempotencyKey, maxAttempts) {
  if (!isSafeQueueName(type) || !runtime.allowedJobTypes.includes(type)) {
    queueFail('INVALID_QUEUE_JOB_TYPE', 'Job type is outside the configured allowlist.');
  }
  validateQueueIdempotencyKey(runtime, idempotencyKey);
  if (!Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > runtime.limits.maxAttempts) {
    queueFail('INVALID_QUEUE_ATTEMPTS', 'Job attempts exceed queue policy.');
  }
}

export function validateQueueIdempotencyKey(runtime, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey
    || Buffer.byteLength(idempotencyKey) > runtime.limits.maxIdempotencyKeyBytes) {
    queueFail('INVALID_IDEMPOTENCY_KEY', 'A bounded idempotency key is required.');
  }
}

export function validateQueueFailure(classification, message, retryNotBefore, retryDelayMs) {
  if (!['transient', 'permanent'].includes(classification)) {
    queueFail('INVALID_QUEUE_FAILURE', 'Failure classification must be transient or permanent.');
  }
  if (typeof message !== 'string') {
    queueFail('INVALID_QUEUE_FAILURE', 'Failure message must be a string.');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0
    || retryDelayMs > 24 * 60 * 60 * 1000
    || (retryNotBefore !== null && retryDelayMs !== 0)) {
    queueFail('INVALID_QUEUE_BACKOFF', 'Queue retry delay is invalid.');
  }
  if (classification === 'permanent' && (retryNotBefore !== null || retryDelayMs !== 0)) {
    queueFail('INVALID_QUEUE_BACKOFF', 'Permanent failures cannot request a retry.');
  }
}
