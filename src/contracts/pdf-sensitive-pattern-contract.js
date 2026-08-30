import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_SENSITIVE_PATTERN_PROFILE = 'local-source-bound-sensitive-pattern-scan-v1';
export const MAX_CUSTOM_PATTERNS = 20;
export const MAX_PAGES = 200;
export const MAX_MATCHES = 500;
export const MAX_PAGE_BYTES = 100_000;
export const PDF_SENSITIVE_PATTERN_LIMITATIONS = Object.freeze([
  'Candidate detection uses extracted text and deterministic local rules only; it is not OCR, semantic classification, or a guarantee that sensitive content was found.',
  'Matches contain page and character ranges, kinds, and labels only; matched text, snippets, PDF bytes, and filesystem paths are not returned.',
  'This read-only operation does not create redaction marks, mutate the source, apply redactions, or remove content.',
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_REGEX = /^[A-Za-z0-9 _.,:@+*?\-()[\]{}|\\^$]{1,128}$/u;
const MATCH_KINDS = new Set(['email', 'phone', 'payment-card', 'custom-regex', 'custom-literal']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourceUnchanged', 'localOnly', 'textReturned', 'pathsReturned', 'bounded',
]);

function invalid(message) { throw new TypeError(`Sensitive-pattern contract is invalid: ${message}`); }

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbols = Reflect.ownKeys(descriptors).filter((key) => typeof key !== 'string');
  if (symbols.length || Object.keys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)
    || Object.keys(descriptors).some((key) => !keys.includes(key))) invalid(`${label} has an unsupported shape.`);
  return value;
}

function safeText(value, label, maximum, { allowBackslash = false } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value !== value.normalize('NFC') || /[\u0000-\u001f\u007f-\u009f\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)
    || value.includes('/') || (!allowBackslash && value.includes('\\')) || new TextEncoder().encode(value).byteLength > maximum * 4) invalid(`${label} is invalid.`);
  return value;
}

function safePattern(value, index) {
  exact(value, ['label', 'pattern', 'regex'], `customPatterns[${index}]`);
  const label = safeText(value.label, `customPatterns[${index}].label`, 80);
  const pattern = safeText(value.pattern, `customPatterns[${index}].pattern`, 128, { allowBackslash: true });
  if (typeof value.regex !== 'boolean') invalid(`customPatterns[${index}].regex must be boolean.`);
  if (value.regex && (!SAFE_REGEX.test(pattern)
    || /\([^)]*[+*][^)]*\)[+*?]/.test(pattern) || /\.\*[+*?]/.test(pattern))) invalid(`customPatterns[${index}] uses unsafe regex syntax.`);
  return { label, pattern, regex: value.regex };
}

function snapshot(value, state, depth = 0) {
  state.items += 1;
  if (state.items > 4_000 || depth > 12) invalid('input exceeds structural limits.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid('input contains a non-finite number.'); return value; }
  if (typeof value === 'string') {
    state.bytes += new TextEncoder().encode(value).byteLength;
    if (state.bytes > MAX_TEXT_BYTES) invalid('input contains oversized text.');
    return value;
  }
  if (!value || typeof value !== 'object' || state.active.has(value)) invalid('input must be acyclic plain data.');
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid('input contains a hostile object.');
  }
  if (prototype !== Object.prototype && prototype !== Array.prototype) invalid('input contains an exotic object.');
  const keys = Reflect.ownKeys(descriptors);
  state.active.add(value);
  let copied;
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    const actual = keys.filter((key) => key !== 'length');
    const expected = Number.isSafeInteger(length) && length >= 0 && length <= MAX_MATCHES
      ? Array.from({ length }, (_, index) => String(index)) : [];
    if (!Number.isSafeInteger(length) || actual.length !== expected.length || actual.some((key) => typeof key !== 'string')
      || expected.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) invalid('arrays must be dense data arrays.');
    copied = expected.map((key) => snapshot(descriptors[key].value, state, depth + 1));
  } else {
    if (keys.some((key) => typeof key !== 'string' || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) invalid('objects must contain enumerable data properties.');
    copied = {};
    for (const key of keys) Object.defineProperty(copied, key, { value: snapshot(descriptors[key].value, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  state.active.delete(value);
  return copied;
}

function snapshotJson(value) {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) invalid('inherited JSON hooks are not allowed.');
  return snapshot(value, { active: new Set(), items: 0, bytes: 0 });
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function normalizePdfSensitivePatternRequest(value) {
  const copied = snapshotJson(value);
  exact(copied, ['profile', 'sourceSha256', 'customPatterns'], 'request');
  if (copied.profile !== PDF_SENSITIVE_PATTERN_PROFILE || !SHA256.test(copied.sourceSha256 ?? '') || !Array.isArray(copied.customPatterns)
    || copied.customPatterns.length > MAX_CUSTOM_PATTERNS) invalid('request identity is invalid.');
  const customPatterns = copied.customPatterns.map(safePattern);
  return freeze({ profile: PDF_SENSITIVE_PATTERN_PROFILE, sourceSha256: copied.sourceSha256, customPatterns: freeze(customPatterns.map((entry) => freeze(entry))) });
}

function validEvidence(value) {
  exact(value, EVIDENCE_KEYS, 'evidence');
  if (EVIDENCE_KEYS.some((key) => typeof value[key] !== 'boolean')
    || value.sourceDigestReverified !== true || value.sourceUnchanged !== true
    || value.localOnly !== true || value.textReturned !== false
    || value.pathsReturned !== false || value.bounded !== true) invalid('evidence booleans are inconsistent.');
}

function validMatch(value, index, pageCount, labels) {
  exact(value, ['id', 'page', 'start', 'end', 'kind', 'label'], `matches[${index}]`);
  safeText(value.kind, `matches[${index}].kind`, 64);
  safeText(value.label, `matches[${index}].label`, 80);
  if (value.id !== `match-${index + 1}` || !MATCH_KINDS.has(value.kind)
    || (value.kind.startsWith('custom-') && !labels.has(value.label))
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > pageCount
    || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || value.start < 0 || value.end <= value.start || value.end > MAX_PAGE_BYTES) invalid(`matches[${index}] is invalid.`);
}

export function validatePdfSensitivePatternResult(value, { documentId, sourceSha256, request } = {}) {
  const copied = snapshotJson(value);
  exact(copied, ['kind', 'profile', 'documentId', 'sourceSha256', 'pageCount', 'matches', 'matchCount', 'truncated', 'evidence', 'limitations'], 'result');
  if (copied.kind !== 'pdf-sensitive-pattern-scan' || copied.profile !== PDF_SENSITIVE_PATTERN_PROFILE || copied.documentId !== documentId
    || copied.sourceSha256 !== sourceSha256 || !Number.isSafeInteger(copied.pageCount) || copied.pageCount < 1 || copied.pageCount > MAX_PAGES
    || !Array.isArray(copied.matches) || copied.matches.length > MAX_MATCHES || !Number.isSafeInteger(copied.matchCount)
    || copied.matchCount < 0 || copied.matchCount > MAX_MATCHES || copied.matchCount !== copied.matches.length
    || typeof copied.truncated !== 'boolean' || copied.truncated !== (copied.matchCount === MAX_MATCHES)) invalid('result identity or bounds are invalid.');
  const labels = new Set((request?.customPatterns ?? []).map(({ label }) => label));
  let previous = null;
  copied.matches.forEach((match, index) => {
    validMatch(match, index, copied.pageCount, labels);
    if (previous && (match.page < previous.page || (match.page === previous.page && (match.start < previous.start || (match.start === previous.start && match.end < previous.end))))) invalid('matches must be ordered.');
    previous = match;
  });
  validEvidence(copied.evidence);
  if (!Array.isArray(copied.limitations) || copied.limitations.length !== PDF_SENSITIVE_PATTERN_LIMITATIONS.length || copied.limitations.some((item, index) => item !== PDF_SENSITIVE_PATTERN_LIMITATIONS[index])) invalid('limitations are invalid.');
  return freeze(copied);
}

export function validatePdfSensitivePatternResponse(body, context) {
  const copied = snapshotJson(body);
  exact(copied, ['result'], 'response');
  return validatePdfSensitivePatternResult(copied.result, context);
}
