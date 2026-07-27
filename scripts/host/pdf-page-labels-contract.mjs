export const PDF_PAGE_LABELS_PROFILE = 'local-page-labels-v1';
export const PAGE_LABELS_PROFILE = PDF_PAGE_LABELS_PROFILE;

const STYLES = new Set(['D', 'R', 'r', 'A', 'a', 'none']);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RANGES = 20;
const MAX_PREFIX_BYTES = 256;

function invalid(message = 'PDF page-labels request is invalid.') {
  const error = new Error(message); error.code = 'INVALID_PDF_PAGE_LABELS'; return error;
}
function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid();
  return descriptors;
}

function printablePrefix(prefix) {
  if (prefix === undefined) return '';
  if (typeof prefix !== 'string' || prefix !== prefix.normalize('NFC') || /[\u0000-\u001F\u007F\u0080-\u009F\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(prefix)) throw invalid('Page-label prefixes must be NFC printable text.');
  if (Buffer.byteLength(prefix, 'utf8') > MAX_PREFIX_BYTES) throw invalid('Page-label prefixes exceed the bounded UTF-8 limit.');
  return prefix;
}

export function normalizePdfPageLabels(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'ranges']);
  if (request.profile.value !== PDF_PAGE_LABELS_PROFILE || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  const ranges = request.ranges.value;
  if (!Array.isArray(ranges) || Object.getPrototypeOf(ranges) !== Array.prototype || ranges.length < 1 || ranges.length > MAX_RANGES) throw invalid();
  const normalized = []; let previous = -1;
  for (const entry of ranges) {
    const descriptors = exactObject(entry, ['start', 'style'], ['prefix', 'startNumber']);
    const start = descriptors.start.value; const style = descriptors.style.value;
    if (!Number.isSafeInteger(start) || start < 0 || start <= previous || !STYLES.has(style)) throw invalid('Page-label range starts must be strictly ascending zero-based integers.');
    const prefix = printablePrefix(descriptors.prefix?.value);
    const hasStartNumber = Object.hasOwn(descriptors, 'startNumber');
    const startNumber = descriptors.startNumber?.value;
    if (style === 'none' ? hasStartNumber : (!hasStartNumber || !Number.isSafeInteger(startNumber) || startNumber < 1 || startNumber > 1_000_000)) throw invalid('Page-label start numbers do not match the selected style.');
    previous = start;
    normalized.push(Object.freeze({ start, style, prefix, ...(style === 'none' ? {} : { startNumber }) }));
  }
  return Object.freeze({ profile: PDF_PAGE_LABELS_PROFILE, sourceSha256: request.sourceSha256.value, ranges: Object.freeze(normalized) });
}

export const normalizePageLabels = normalizePdfPageLabels;
