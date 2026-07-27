import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { deepFreeze } from './accessibility-review-utils.mjs';
import {
  ACCESSIBILITY_COLOR_CONTRAST_PROFILE,
  MAX_CONTRAST_PAGES,
  contrastReportHash,
  normalizeAccessibilityColorContrastRequest,
  validateContrastEvidence,
} from './accessibility-color-contrast-contract.mjs';

const MAX_JOB_MS = 120_000;
const LIMITATIONS = Object.freeze([
  'This is a bounded human-review heuristic, not complete color-only detection.',
  'Only trusted source-bound sRGB samples are evaluated; transparent, ICC, gradient, and ambiguous backgrounds are not certified.',
  'The report makes no WCAG, PDF/UA, or conformance claim and never mutates the source PDF.',
]);

function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function luminance({ r, g, b }) {
  const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear(r)) + (0.7152 * linear(g)) + (0.0722 * linear(b));
}
function ratio(foreground, background) { const a = luminance(foreground); const b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
function cancelled(signal) { if (signal.aborted) throw signal.reason ?? new Error('Accessibility color-contrast review was cancelled.'); }
function classifySample(sample) {
  if (sample.foreground.a !== 1 || sample.background.a !== 1) return { status: 'not-checked', reason: 'transparent-color' };
  if (sample.confidence === 'low' || sample.pairing === 'trusted-raster-region') return { status: 'not-checked', reason: sample.confidence === 'low' ? 'low-confidence-pairing' : 'raster-region-requires-human-pairing' };
  const contrast = ratio(sample.foreground, sample.background);
  return { status: contrast < 4.5 ? 'warning' : 'pass', contrast, ...(contrast < 4.5 ? { reason: 'likely-low-contrast' } : {}) };
}
function pageResult(evidence) {
  const findings = evidence.samples.map((sample) => Object.freeze({ id: sample.id, bounds: sample.bounds, foreground: sample.foreground, background: sample.background, pairing: sample.pairing, ...classifySample(sample) }));
  for (const group of evidence.colorOnlyGroups) if (!group.nonColorCue) findings.push(Object.freeze({ id: `color-only-${group.id}`, groupId: group.id, status: 'warning', reason: 'repeated-color-distinction-without-non-color-cue' }));
  for (const warning of evidence.warnings) findings.push(Object.freeze({ id: `renderer-${findings.length + 1}`, status: 'not-checked', reason: warning }));
  return Object.freeze({ page: evidence.page, width: evidence.width, height: evidence.height, sampleCount: evidence.samples.length, findings: Object.freeze(findings), status: findings.some(({ status }) => status === 'warning') ? 'warning' : findings.some(({ status }) => status === 'not-checked') ? 'not-checked' : 'pass' });
}

export class AccessibilityColorContrastReviewService {
  #store; #renderer;
  constructor({ store, renderer } = {}) {
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') throw new TypeError('AccessibilityColorContrastReviewService requires a DocumentStore-compatible store.');
    if (!renderer || typeof renderer.inspect !== 'function') throw new TypeError('AccessibilityColorContrastReviewService requires trusted renderer evidence.');
    this.#store = store; this.#renderer = renderer;
  }

  async review(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request; try { request = normalizeAccessibilityColorContrastRequest(value); } catch (error) { throw host('ACCESSIBILITY_COLOR_CONTRAST_OPTIONS_INVALID', 'Accessibility color-contrast options are invalid.', 400, error); }
    const document = this.#store.getDocument(documentId); if (document.sha256 !== request.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The color-contrast source digest does not match the current document.', 409);
    const deadline = createDeadline(signal, MAX_JOB_MS); const pages = []; let report;
    try {
      cancelled(deadline.signal); await this.#store.verifySource(documentId);
      const pageCount = Number.isSafeInteger(document.pageCount) ? document.pageCount : (await this.#renderer.pageCount?.(documentId, { signal: deadline.signal }));
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_CONTRAST_PAGES) throw host('ACCESSIBILITY_COLOR_CONTRAST_PAGE_LIMIT', 'Color-contrast review is limited to 200 pages.', 422);
      for (let page = 1; page <= pageCount; page += 1) {
        cancelled(deadline.signal);
        let raw; try { raw = await this.#renderer.inspect(documentId, { page, sourceSha256: document.sha256, signal: deadline.signal }); } catch (error) { if (deadline.signal.aborted) throw error; throw host('ACCESSIBILITY_COLOR_CONTRAST_RENDER_UNAVAILABLE', 'Trusted renderer evidence was unavailable.', 422, error); }
        const evidence = validateContrastEvidence(raw, { sourceSha256: document.sha256, page }); pages.push(pageResult(evidence));
      }
      await this.#store.verifySource(documentId); cancelled(deadline.signal);
      const findings = pages.reduce((sum, page) => sum + page.findings.length, 0); const warnings = pages.reduce((sum, page) => sum + page.findings.filter(({ status }) => status === 'warning').length, 0); const unchecked = pages.reduce((sum, page) => sum + page.findings.filter(({ status }) => status === 'not-checked').length, 0);
      const unsigned = { kind: 'accessibility-color-contrast-review', profile: ACCESSIBILITY_COLOR_CONTRAST_PROFILE, sourceDigest: document.sha256, pageCount, status: warnings ? 'review-required' : 'review-required', counts: { pages: pageCount, findings, warnings, 'not-checked': unchecked }, pages, evidence: { sourceBound: true, renderer: 'poppler-raster-evidence-v1', localOnly: true }, limitations: LIMITATIONS };
      report = deepFreeze({ ...unsigned, reportSha256: contrastReportHash(unsigned) }); return report;
    } catch (error) { if (deadline.timedOut) throw host('ACCESSIBILITY_COLOR_CONTRAST_TIMEOUT', 'Accessibility color-contrast review exceeded its deadline.', 504, error); if (signal?.aborted) throw host('JOB_CANCELLED', 'Accessibility color-contrast review was cancelled.', 499, error); if (error instanceof HostError || error?.code === 'SOURCE_INTEGRITY_FAILED') throw error; throw host('ACCESSIBILITY_COLOR_CONTRAST_FAILED', 'The local host could not complete color-contrast review.', 502, error); } finally { deadline.dispose(); }
  }
}

export function createAccessibilityColorContrastReviewService(options) { return new AccessibilityColorContrastReviewService(options); }
export const AccessibilityColorContrastService = AccessibilityColorContrastReviewService;
