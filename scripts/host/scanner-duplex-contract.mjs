import { types as nodeTypes } from 'node:util';

export const SCANNER_DUPLEX_PROFILE = 'local-scan-duplex-feeder-v1';
export const SCANNER_DUPLEX_MAX_BYTES = 64 * 1024 * 1024;
export const SCANNER_DUPLEX_MAX_PIXELS = 500_000_000;
export const SCANNER_DUPLEX_MAX_PAGES = 50;
export const SCANNER_DUPLEX_MAX_DEADLINE_MS = 120_000;

const DEVICE_ID = /^scanner-[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DPIS = new Set([150, 300, 600]);
const COLORS = new Set(['bw', 'gray', 'color']);
const FAILURE_SUPPORT = new Set(['unsupported', 'unavailable-on-platform']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_SCANNER_DUPLEX_OPTIONS';
  return error;
}

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')
      || keys.some((key) => !Object.hasOwn(descriptors, key))
      || Object.values(descriptors).some((descriptor) => descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value'))) return null;
    return descriptors;
  } catch { return null; }
}

function denseArray(value, maximum) {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1
      || descriptors.length?.enumerable === true || !Object.hasOwn(descriptors.length ?? {}, 'value')) return null;
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch { return null; }
}

export function validateScannerDuplexOptions(value) {
  const keys = ['profile', 'deviceId', 'source', 'duplex', 'color', 'dpi', 'pageCount',
    'maxPixels', 'maxBytes', 'deadlineMs', 'format'];
  const fields = exact(value, keys);
  if (!fields || fields.profile.value !== SCANNER_DUPLEX_PROFILE
    || !DEVICE_ID.test(fields.deviceId.value ?? '') || fields.source.value !== 'feeder'
    || fields.duplex.value !== true || !COLORS.has(fields.color.value)
    || !DPIS.has(fields.dpi.value) || !Number.isSafeInteger(fields.pageCount.value)
    || fields.pageCount.value < 2 || fields.pageCount.value > SCANNER_DUPLEX_MAX_PAGES
    || fields.pageCount.value % 2 !== 0 || !Number.isSafeInteger(fields.maxPixels.value)
    || fields.maxPixels.value < 1 || fields.maxPixels.value > SCANNER_DUPLEX_MAX_PIXELS
    || !Number.isSafeInteger(fields.maxBytes.value) || fields.maxBytes.value < 1
    || fields.maxBytes.value > SCANNER_DUPLEX_MAX_BYTES
    || !Number.isSafeInteger(fields.deadlineMs.value) || fields.deadlineMs.value < 1
    || fields.deadlineMs.value > SCANNER_DUPLEX_MAX_DEADLINE_MS
    || fields.format.value !== 'PDF') {
    throw invalid('Scanner duplex options do not match the bounded feeder profile.');
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, fields[key].value])));
}

function parseSuccessEvidence(value) {
  const fields = exact(value, ['api', 'discoveryAttempted', 'liveVerification', 'scanSupport',
    'persistentIdentityVerified', 'feederSupportAdvertised']);
  if (!fields || fields.api.value !== 'ImageCaptureCore' || fields.discoveryAttempted.value !== true
    || fields.liveVerification.value !== true || fields.scanSupport.value !== 'duplex-feeder-supported'
    || fields.persistentIdentityVerified.value !== true
    || fields.feederSupportAdvertised.value !== true) return null;
  return Object.freeze(Object.fromEntries(Object.keys(fields).map((key) => [key, fields[key].value])));
}

function parseFailureEvidence(value) {
  const fields = exact(value, ['api', 'discoveryAttempted', 'liveVerification', 'scanSupport']);
  if (!fields || fields.api.value !== 'ImageCaptureCore'
    || typeof fields.discoveryAttempted.value !== 'boolean' || fields.liveVerification.value !== false
    || !FAILURE_SUPPORT.has(fields.scanSupport.value)) return null;
  return Object.freeze(Object.fromEntries(Object.keys(fields).map((key) => [key, fields[key].value])));
}

function parsePages(value, pageCount) {
  const entries = denseArray(value, SCANNER_DUPLEX_MAX_PAGES);
  if (!entries || entries.length !== pageCount) return null;
  const pages = [];
  let totalPixels = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const fields = exact(entries[index], ['sequence', 'sheet', 'side', 'width', 'height', 'pixels', 'digest']);
    const sequence = index + 1;
    const width = fields?.width.value;
    const height = fields?.height.value;
    const pixels = fields?.pixels.value;
    if (!fields || fields.sequence.value !== sequence || fields.sheet.value !== Math.ceil(sequence / 2)
      || fields.side.value !== (sequence % 2 === 1 ? 'front' : 'back')
      || !Number.isSafeInteger(width) || width < 1 || width > 20_000
      || !Number.isSafeInteger(height) || height < 1 || height > 20_000
      || !Number.isSafeInteger(pixels) || pixels !== width * height || pixels > 100_000_000
      || !SHA256.test(fields.digest.value ?? '')) return null;
    totalPixels += pixels;
    if (totalPixels > SCANNER_DUPLEX_MAX_PIXELS) return null;
    pages.push(Object.freeze({ sequence, sheet: fields.sheet.value, side: fields.side.value,
      width, height, pixels, digest: fields.digest.value }));
  }
  return Object.freeze({ pages: Object.freeze(pages), totalPixels });
}

export function parseScannerDuplexEnvelope(body) {
  const envelope = exact(body, ['version', 'ok', 'result', 'error']);
  if (!envelope || envelope.version.value !== 1 || typeof envelope.ok.value !== 'boolean') {
    throw new TypeError('Scanner duplex response envelope is invalid.');
  }
  if (envelope.ok.value) {
    const result = exact(envelope.result.value, ['outputName', 'format', 'pageCount', 'bytes',
      'digest', 'pages', 'evidence']);
    const pageCount = result?.pageCount.value;
    const parsedPages = Number.isSafeInteger(pageCount) ? parsePages(result.pages.value, pageCount) : null;
    const parsedEvidence = result ? parseSuccessEvidence(result.evidence.value) : null;
    if (!result || envelope.error.value !== null || result.outputName.value !== 'duplex-scan.pdf'
      || result.format.value !== 'PDF' || pageCount < 2 || pageCount > SCANNER_DUPLEX_MAX_PAGES
      || pageCount % 2 !== 0 || !Number.isSafeInteger(result.bytes.value) || result.bytes.value < 1
      || result.bytes.value > SCANNER_DUPLEX_MAX_BYTES || !SHA256.test(result.digest.value ?? '')
      || !parsedPages || !parsedEvidence) throw new TypeError('Scanner duplex success is invalid.');
    return Object.freeze({ version: 1, ok: true, result: Object.freeze({
      outputName: 'duplex-scan.pdf', format: 'PDF', pageCount, bytes: result.bytes.value,
      digest: result.digest.value, pages: parsedPages.pages, totalPixels: parsedPages.totalPixels,
      evidence: parsedEvidence,
    }), error: null });
  }
  const failure = exact(envelope.error.value, ['code', 'reason', 'evidence']);
  const parsedEvidence = failure ? parseFailureEvidence(failure.evidence.value) : null;
  if (envelope.result.value !== null || !failure
    || !/^[A-Z0-9][A-Z0-9_-]{1,63}$/u.test(failure.code.value ?? '')
    || typeof failure.reason.value !== 'string' || failure.reason.value.normalize('NFC') !== failure.reason.value
    || failure.reason.value.length < 1 || failure.reason.value.length > 160
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(failure.reason.value) || !parsedEvidence) {
    throw new TypeError('Scanner duplex failure is invalid.');
  }
  return Object.freeze({ version: 1, ok: false, result: null, error: Object.freeze({
    code: failure.code.value, reason: failure.reason.value, evidence: parsedEvidence,
  }) });
}
