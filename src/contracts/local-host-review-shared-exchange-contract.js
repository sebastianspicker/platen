export const REVIEW_SHARED_EXCHANGE_PROFILE = 'local-review-shared-exchange-v1';
export const REVIEW_SHARED_EXCHANGE_MEDIA_TYPE = 'application/vnd.platen.review-exchange+zip';
export const REVIEW_SHARED_EXCHANGE_MAX_BYTES = 600 * 1024;
export const REVIEW_SHARED_EXCHANGE_MAX_DELTAS = 500;
export const REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_BASE64_LENGTH = Math.ceil(REVIEW_SHARED_EXCHANGE_MAX_BYTES / 3) * 4;
const MANIFEST_KEYS = ['baseRevision', 'deltaCount', 'deltasSha256', 'payloadSha256', 'profile', 'reviewerId', 'schemaVersion', 'sourceSha256'];

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function validArchiveBase64(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_BASE64_LENGTH
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : (value.endsWith('=') ? 1 : 0);
  const byteLength = archiveByteLength(value, padding);
  if (byteLength < 1 || byteLength > REVIEW_SHARED_EXCHANGE_MAX_BYTES) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding === 2) return (alphabet.indexOf(value.at(-3)) & 0b1111) === 0;
  return padding !== 1 || (alphabet.indexOf(value.at(-2)) & 0b11) === 0;
}

export { validArchiveBase64 as validReviewSharedExchangeArchive };

function archiveByteLength(value, padding = value.endsWith('==') ? 2 : (value.endsWith('=') ? 1 : 0)) {
  return (value.length / 4) * 3 - padding;
}

function validManifest(value) {
  return exact(value, MANIFEST_KEYS) && value.profile === REVIEW_SHARED_EXCHANGE_PROFILE
    && value.schemaVersion === REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION && SHA256.test(value.sourceSha256 ?? '')
    && REVIEWER.test(value.reviewerId ?? '') && Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0
    && Number.isSafeInteger(value.deltaCount) && value.deltaCount >= 0 && value.deltaCount <= REVIEW_SHARED_EXCHANGE_MAX_DELTAS
    && SHA256.test(value.deltasSha256 ?? '') && SHA256.test(value.payloadSha256 ?? '');
}

function validExportResult(result, { sourceSha256, reviewerId, baseRevision } = {}) {
  if (!exact(result, ['kind', 'archiveBase64', 'displayName', 'mediaType', 'size', 'sha256', 'manifest'])
    || result.kind !== REVIEW_SHARED_EXCHANGE_PROFILE || !validArchiveBase64(result.archiveBase64)
    || result.displayName !== 'review-exchange.platen.zip'
    || result.mediaType !== REVIEW_SHARED_EXCHANGE_MEDIA_TYPE
    || !Number.isSafeInteger(result.size) || result.size < 1 || result.size > REVIEW_SHARED_EXCHANGE_MAX_BYTES
    || !SHA256.test(result.sha256 ?? '')) return false;
  const manifest = result.manifest;
  return archiveByteLength(result.archiveBase64) === result.size
    && validManifest(manifest) && manifest.sourceSha256 === sourceSha256 && manifest.reviewerId === reviewerId
    && manifest.baseRevision === baseRevision && result.size <= REVIEW_SHARED_EXCHANGE_MAX_BYTES;
}

function validImportResult(result, { sourceSha256 } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.getPrototypeOf(result) !== Object.prototype) return false;
  const idempotentDescriptor = Object.getOwnPropertyDescriptor(result, 'idempotent');
  if (!idempotentDescriptor || !Object.hasOwn(idempotentDescriptor, 'value')) return false;
  const resultKeys = idempotentDescriptor.value
    ? ['kind', 'applied', 'notificationsApplied', 'idempotent', 'sourceSha256', 'revision']
    : ['kind', 'applied', 'notificationsApplied', 'idempotent', 'sourceSha256', 'revision', 'manifestSha256'];
  if (!exact(result, resultKeys)
    || result.kind !== REVIEW_SHARED_EXCHANGE_PROFILE || result.sourceSha256 !== sourceSha256
    || !Number.isSafeInteger(result.applied) || result.applied < 0
    || !Number.isSafeInteger(result.notificationsApplied) || result.notificationsApplied < 0
    || typeof result.idempotent !== 'boolean' || !Number.isSafeInteger(result.revision) || result.revision < 0) return false;
  return result.idempotent || SHA256.test(result.manifestSha256 ?? '');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function copyTree(value) {
  if (Array.isArray(value)) return value.map(copyTree);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Object.keys(value)) copy[key] = copyTree(value[key]);
  return copy;
}

function invalidResult(message) {
  throw new TypeError(message);
}

export function validateReviewSharedExchangeExportResult(result, context = {}) {
  if (!validExportResult(result, context)) invalidResult('The local host returned an invalid review-exchange export result.');
  return deepFreeze(copyTree(result));
}

export function validateReviewSharedExchangeImportResult(result, context = {}) {
  if (!validImportResult(result, context)) invalidResult('The local host returned an invalid review-exchange import result.');
  return deepFreeze(copyTree(result));
}
