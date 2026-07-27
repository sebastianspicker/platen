export const CLEANUP_PRESETS = Object.freeze(['none', 'document', 'bilevel']);
export const SEGMENTATION_MODES = Object.freeze(['auto', 'single-column', 'block', 'sparse']);
export const ZONE_TYPES = Object.freeze(['text', 'table', 'image', 'exclude']);
export const LANGUAGE_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;
export const ZONE_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const DOCUMENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const OCR_LIMITS = Object.freeze({
  maxDocumentPages: 50,
  maxLayoutPages: 10,
  maxZones: 32,
  maxZonesPerPage: 8,
  maxBatchRequests: 8,
  maxUserDictionaryTerms: 256,
  maxUserDictionaryTermLength: 128,
  maxUserDictionaryCharacters: 16_384,
  minNormalizedZoneSize: 16 / 3200,
});

export function invalid(message) {
  const error = new TypeError(message);
  error.code = 'OCR_CONTRACT_INVALID';
  throw error;
}

export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${label} contains unsupported fields.`);
  }
  return value;
}

export function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

export function digest(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) {
    invalid(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function nonEmptyStrings(
  value,
  label,
  { maximumItems = 64, maximumLength = 240 } = {},
) {
  if (!Array.isArray(value) || !value.length || value.length > maximumItems
    || value.some((item) => (
      typeof item !== 'string' || !item || item.length > maximumLength
    ))) {
    invalid(`${label} must contain bounded non-empty strings.`);
  }
  return value;
}
