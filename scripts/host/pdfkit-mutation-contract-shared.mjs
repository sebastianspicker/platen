import { HostError } from './host-error.mjs';

export const DEFAULT_PDFKIT_MUTATION_LIMITS = Object.freeze({
  maxPages: 100,
  maxAnnotationsPerPage: 50,
  maxWidgetsPerPage: 50,
  maxOutlineDepth: 8,
  maxOutlineItems: 200,
  timeoutMs: 30_000,
});

export const PDFKIT_DERIVED_PROFILE = 'macos-pdfkit-derived-v1';
export const PDFKIT_TARGETED_PROFILE = 'macos-pdfkit-targeted-v1';
export const PDFKIT_LOCAL_GOTO_PROFILE = 'macos-pdfkit-local-goto-v1';
export const PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE = 'macos-pdfkit-local-goto-remove-v1';
export const PDFKIT_LINE_ANNOTATION_PROFILE = 'macos-pdfkit-line-annotation-v1';
export const PDFKIT_INK_ANNOTATION_PROFILE = 'macos-pdfkit-ink-annotation-v1';
export const PDFKIT_OUTLINE_PROFILE = 'macos-pdfkit-outline-v1';
export const PDFKIT_OUTLINE_REMOVAL_PROFILE = 'macos-pdfkit-outline-remove-v1';
export const PDFKIT_OUTLINE_RENAME_PROFILE = 'macos-pdfkit-outline-rename-v1';

const MAX_STRING_BYTES = 1_024;
const MAX_COORDINATE = 1_000_000;
const LOCATOR_FINGERPRINT = /^[0-9a-f]{64}$/;

export function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some((key) => !keys.has(key))) {
    fail('INVALID_PDFKIT_MUTATION', `${label} must contain exactly the supported fields.`);
  }
  return value;
}

export function nullableString(value, label, maximum = MAX_STRING_BYTES) {
  if (value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) {
    fail('INVALID_PDFKIT_MUTATION', `${label} must be null or bounded UTF-8 text.`);
  }
  return value;
}

export function pageNumber(value, pageCount, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > pageCount) {
    fail('INVALID_PDFKIT_MUTATION', `${label} is outside the document.`);
  }
  return value;
}

export function rectangle(value, label) {
  exactObject(value, new Set(['x', 'y', 'width', 'height']), label);
  const output = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])
      || Math.abs(value[key]) > MAX_COORDINATE) {
      fail('INVALID_PDFKIT_MUTATION', `${label}.${key} must be a bounded finite number.`);
    }
    output[key] = value[key];
  }
  if (output.width <= 0 || output.height <= 0) {
    fail('INVALID_PDFKIT_MUTATION', `${label} must have positive dimensions.`);
  }
  return Object.freeze(output);
}

export function point(value, label) {
  exactObject(value, new Set(['x', 'y']), label);
  const output = {};
  for (const key of ['x', 'y']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])
      || Math.abs(value[key]) > MAX_COORDINATE) {
      fail('INVALID_PDFKIT_MUTATION', `${label}.${key} must be a bounded finite number.`);
    }
    output[key] = value[key];
  }
  return Object.freeze(output);
}

export function locator(value, keys, pageCount, label) {
  const input = exactObject(value, keys, label);
  if (!Number.isSafeInteger(input.annotationIndex) || input.annotationIndex < 0
    || input.annotationIndex >= DEFAULT_PDFKIT_MUTATION_LIMITS.maxAnnotationsPerPage
    || !LOCATOR_FINGERPRINT.test(input.fingerprint)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      `${label} requires a bounded source-bound annotation locator.`,
    );
  }
  return {
    page: pageNumber(input.page, pageCount, `${label}.page`),
    annotationIndex: input.annotationIndex,
    fingerprint: input.fingerprint,
  };
}

export function outlineLocator(value, label) {
  const input = exactObject(value, new Set(['topLevelIndex', 'fingerprint']), label);
  if (!Number.isSafeInteger(input.topLevelIndex) || input.topLevelIndex < 0
    || input.topLevelIndex >= DEFAULT_PDFKIT_MUTATION_LIMITS.maxOutlineItems
    || !LOCATOR_FINGERPRINT.test(input.fingerprint)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      `${label} requires a bounded source-bound top-level outline locator.`,
    );
  }
  return Object.freeze({
    topLevelIndex: input.topLevelIndex,
    fingerprint: input.fingerprint,
  });
}
