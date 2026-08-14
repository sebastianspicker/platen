export const SCANNER_ACQUISITION_PROFILE = 'local-scan-acquire-v1';
export const SCANNER_ACQUISITION_MAX_BYTES = 64 * 1024 * 1024;
export const SCANNER_ACQUISITION_MAX_DEADLINE_MS = 120_000;
export const SCANNER_ACQUISITION_DPIS = Object.freeze([150, 300, 600]);
export const SCANNER_ACQUISITION_COLORS = Object.freeze(['bw', 'gray', 'color']);

const OPAQUE_SCANNER_ID = /^scanner-[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EVIDENCE_KEYS = ['api', 'discoveryAttempted', 'liveVerification', 'scanSupport'];
const FAILURE_SUPPORT = new Set(['unsupported', 'unavailable-on-platform']);

function exactObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string') || !keys.every((key) => ownKeys.includes(key))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], 'value') && !Object.hasOwn(descriptors[key], 'get') && !Object.hasOwn(descriptors[key], 'set'));
  } catch { return false; }
}

function boundedText(value) {
  return typeof value === 'string' && value === value.normalize('NFC') && value.length > 0 && value.length <= 160
    && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
}

function evidence(value) {
  return exactObject(value, EVIDENCE_KEYS) && value.api === 'ImageCaptureCore'
    && value.discoveryAttempted === true && value.liveVerification === true && value.scanSupport === 'supported';
}

function failureEvidence(value) {
  return exactObject(value, EVIDENCE_KEYS) && value.api === 'ImageCaptureCore'
    && typeof value.discoveryAttempted === 'boolean' && value.liveVerification === false && FAILURE_SUPPORT.has(value.scanSupport);
}

function ownData(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

export function validateScannerAcquisitionOptions(value) {
  const keys = ['profile', 'deviceId', 'source', 'duplex', 'color', 'dpi', 'pageCount', 'maxBytes', 'deadlineMs', 'format'];
  if (!exactObject(value, keys) || ownData(value, 'profile') !== SCANNER_ACQUISITION_PROFILE
    || !OPAQUE_SCANNER_ID.test(ownData(value, 'deviceId') ?? '') || ownData(value, 'source') !== 'flatbed'
    || ownData(value, 'duplex') !== false || !SCANNER_ACQUISITION_COLORS.includes(ownData(value, 'color'))
    || !Number.isSafeInteger(ownData(value, 'dpi')) || !SCANNER_ACQUISITION_DPIS.includes(ownData(value, 'dpi'))
    || ownData(value, 'pageCount') !== 1 || !Number.isSafeInteger(ownData(value, 'maxBytes'))
    || ownData(value, 'maxBytes') < 1 || ownData(value, 'maxBytes') > SCANNER_ACQUISITION_MAX_BYTES
    || !Number.isSafeInteger(ownData(value, 'deadlineMs')) || ownData(value, 'deadlineMs') < 1
    || ownData(value, 'deadlineMs') > SCANNER_ACQUISITION_MAX_DEADLINE_MS || ownData(value, 'format') !== 'PDF') {
    const error = new TypeError('Scanner acquisition options do not match the bounded flatbed PDF profile.');
    error.code = 'INVALID_SCANNER_ACQUISITION_OPTIONS';
    throw error;
  }
  return Object.freeze({
    profile: ownData(value, 'profile'), deviceId: ownData(value, 'deviceId'), source: ownData(value, 'source'),
    duplex: false, color: ownData(value, 'color'), dpi: ownData(value, 'dpi'), pageCount: 1,
    maxBytes: ownData(value, 'maxBytes'), deadlineMs: ownData(value, 'deadlineMs'), format: 'PDF',
  });
}

export function parseScannerAcquisitionEnvelope(body) {
  if (!exactObject(body, ['version', 'ok', 'result', 'error']) || ownData(body, 'version') !== 1 || typeof ownData(body, 'ok') !== 'boolean') throw new TypeError('Scanner acquisition response envelope is invalid.');
  if (body.ok) {
    const result = ownData(body, 'result');
    if (!exactObject(result, ['outputName', 'format', 'pageCount', 'bytes', 'digest', 'evidence'])
      || ownData(body, 'error') !== null || ownData(result, 'outputName') !== 'scan.pdf' || ownData(result, 'format') !== 'PDF'
      || ownData(result, 'pageCount') !== 1 || !Number.isSafeInteger(ownData(result, 'bytes')) || ownData(result, 'bytes') < 1
      || ownData(result, 'bytes') > SCANNER_ACQUISITION_MAX_BYTES || !SHA256.test(ownData(result, 'digest') ?? '') || !evidence(ownData(result, 'evidence'))) throw new TypeError('Scanner acquisition success is invalid.');
  } else {
    const error = ownData(body, 'error');
    if (ownData(body, 'result') !== null || !exactObject(error, ['code', 'reason', 'evidence']) || !/^[A-Z0-9][A-Z0-9_-]{1,63}$/u.test(ownData(error, 'code') ?? '') || !boundedText(ownData(error, 'reason')) || !failureEvidence(ownData(error, 'evidence'))) throw new TypeError('Scanner acquisition failure is invalid.');
  }
  return Object.freeze(body);
}

export { OPAQUE_SCANNER_ID };
