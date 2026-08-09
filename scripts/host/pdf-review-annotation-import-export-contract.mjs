import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';

export const PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE = 'local-review-annotation-import-export-v1';
export const PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_LIMITS = Object.freeze({
  maxSourceBytes: 128 * 1024 * 1024,
  maxXfdfBytes: 16 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/u;

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

function invalid(message = 'Review annotation import/export options are invalid.') {
  throw new HostError('INVALID_REVIEW_ANNOTATION_IMPORT_EXPORT_OPTIONS', message, 400);
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeReviewAnnotationImportExport(value) {
  if (!exact(value, ['profile', 'sourceSha256', 'expectedRevision', 'xfdf'])
    || value.profile !== PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE
    || !SHA256.test(value.sourceSha256 ?? '')
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision > 1_000_000
    || typeof value.xfdf !== 'string' || Buffer.byteLength(value.xfdf, 'utf8') < 1
    || Buffer.byteLength(value.xfdf, 'utf8') > PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_LIMITS.maxXfdfBytes) {
    invalid();
  }
  return freeze({
    profile: PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE,
    sourceSha256: value.sourceSha256,
    expectedRevision: value.expectedRevision,
    xfdf: value.xfdf,
  });
}

export function isSha256(value) { return typeof value === 'string' && SHA256.test(value); }

export { exact, freeze };
