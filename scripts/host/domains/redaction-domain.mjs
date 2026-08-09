import { boundedString, createServiceOptions, requireObject, requireWorkspace } from './trust-accessibility-support.mjs';

const MAX_PAGES = 200;
const MAX_TEXT_LENGTH = 100_000;
const MAX_CUSTOM_PATTERNS = 20;
const MAX_MATCHES = 500;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)(?:\+?\d[\d .()\-]{6,}\d)(?!\w)/g;
const CARD = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
const SAFE_REGEX = /^[A-Za-z0-9 _.,:@+*?\-()[\]{}|\\^$]{1,128}$/;

function pageInput(pages) {
  if (!Array.isArray(pages) || pages.length > MAX_PAGES) throw new TypeError('pages must be a bounded array.');
  return pages.map((page, index) => {
    requireObject(page, 'page');
    const text = boundedString(page.text ?? '', 'page.text', MAX_TEXT_LENGTH);
    const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1;
    return { pageNumber, text, width: Number.isFinite(page.width) ? page.width : undefined, height: Number.isFinite(page.height) ? page.height : undefined };
  });
}

function luhn(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let index = digits.length - 1, parity = 0; index >= 0; index -= 1, parity ^= 1) {
    let digit = Number(digits[index]);
    if (parity) digit *= 2;
    sum += digit > 9 ? digit - 9 : digit;
  }
  return sum % 10 === 0;
}

function safeCustomPatterns(patterns) {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || patterns.length > MAX_CUSTOM_PATTERNS) throw new TypeError('customPatterns must be a bounded array.');
  return patterns.map((entry, index) => {
    requireObject(entry, 'custom pattern');
    const label = boundedString(entry.label ?? `custom-${index + 1}`, 'custom pattern label', 80);
    const source = boundedString(entry.pattern ?? entry.literal ?? '', 'custom pattern', 128);
    const regex = entry.regex === true;
    if (regex && (!SAFE_REGEX.test(source) || /\([^)]*[+*][^)]*\)[+*?]/.test(source) || /\.\*[+*?]/.test(source))) throw new TypeError('Custom regular expressions use a restricted bounded syntax.');
    return { label, regex: regex ? new RegExp(source, 'gi') : null, literal: regex ? null : source };
  });
}

function matchRecord(page, start, end, kind, label, rectangle) {
  return { pageNumber: page.pageNumber, textRange: { start, end }, rectangle: rectangle ?? null, kind, label, preview: `match:${kind}:${label}` };
}

function collectMatches(page, regex, kind, label, predicate = () => true) {
  const matches = [];
  regex.lastIndex = 0;
  let result;
  while ((result = regex.exec(page.text)) && matches.length < MAX_MATCHES) {
    if (predicate(result[0])) matches.push(matchRecord(page, result.index, result.index + result[0].length, kind, label));
    if (result[0].length === 0) regex.lastIndex += 1;
  }
  return matches;
}

/** Pure bounded sensitive-text detector shared by local redaction and source scans. */
export function detectSensitiveTextPages(pages, { customPatterns } = {}) {
  const patterns = safeCustomPatterns(customPatterns);
  const marks = [];
  for (const page of pageInput(pages)) {
    marks.push(...collectMatches(page, EMAIL, 'email', 'Email'));
    marks.push(...collectMatches(page, PHONE, 'phone', 'Phone', (value) => value.replace(/\D/g, '').length <= 15));
    marks.push(...collectMatches(page, CARD, 'payment-card', 'Payment card', luhn));
    for (const pattern of patterns) {
      if (pattern.regex) marks.push(...collectMatches(page, pattern.regex, 'custom-regex', pattern.label));
      else if (pattern.literal) {
        let start = 0;
        while (marks.length < MAX_MATCHES) {
          const found = page.text.indexOf(pattern.literal, start);
          if (found < 0) break;
          marks.push(matchRecord(page, found, found + pattern.literal.length, 'custom-literal', pattern.label));
          start = found + Math.max(1, pattern.literal.length);
        }
      }
    }
    if (marks.length >= MAX_MATCHES) break;
  }
  return Object.freeze(marks.slice(0, MAX_MATCHES).map((mark, index) => Object.freeze({ id: `detected-${index + 1}`, ...mark })));
}

/** Owns local redaction detection and proposal records; it never changes PDF bytes. */
export class RedactionDomainService {
  #workspace;
  #clock;
  #idFactory;

  constructor(workspace, options = {}) {
    this.#workspace = requireWorkspace(workspace);
    ({ clock: this.#clock, idFactory: this.#idFactory } = createServiceOptions(options));
  }

  detectSensitiveText(pages, { customPatterns } = {}) {
    return detectSensitiveTextPages(pages, { customPatterns });
  }

  createRedactionPlan(documentId, { pages, customPatterns, rectangles = [], fullPages = [] } = {}, { expectedRevision } = {}) {
    const detected = this.detectSensitiveText(pages, { customPatterns });
    if (!Array.isArray(rectangles) || !Array.isArray(fullPages) || rectangles.length + fullPages.length > MAX_MATCHES) throw new TypeError('Redaction geometry must be bounded arrays.');
    const geometry = rectangles.map((mark, index) => ({ id: `rectangle-${index + 1}`, pageNumber: mark.pageNumber, rectangle: mark.rectangle, textRange: null, kind: 'rectangle', label: boundedString(mark.label ?? 'Redaction', 'redaction label', 80), preview: 'geometry:rectangle' }));
    const pagesToCover = fullPages.map((pageNumber, index) => ({ id: `full-page-${index + 1}`, pageNumber, rectangle: null, textRange: null, kind: 'full-page', label: 'Full-page redaction', preview: 'geometry:full-page' }));
    const marks = [...detected, ...geometry, ...pagesToCover];
    const record = { id: this.#idFactory('redaction-plan'), type: 'redaction-plan', createdAtLocal: this.#localTime(), status: 'proposed-not-applied', marks, overlays: marks.map((mark) => ({ pageNumber: mark.pageNumber, label: mark.label })), previews: marks.map((mark) => ({ id: mark.id, pageNumber: mark.pageNumber, label: mark.label, preview: mark.preview })), batchPlan: { markCount: marks.length, requestedOperation: 'raster-and-semantic-redaction' }, report: { detectedCount: detected.length, geometryCount: geometry.length + pagesToCover.length, byteRemovalClaim: false }, sanitizationPlan: { status: 'not-applied', hiddenDataRemoval: 'requires-separate-verifier' } };
    return this.#workspace.createEntity(documentId, 'redactions', record, { expectedRevision });
  }

  applyRedactions(_documentId, _planId) {
    return Object.freeze({ status: 'not-applied', code: 'RASTER_SEMANTIC_VERIFIER_REQUIRED', bytesRemoved: false, message: 'No PDF bytes were changed; a separate raster and semantic verifier is required.' });
  }

  #localTime() { return boundedString(this.#clock(), 'clock value', 128); }
}
