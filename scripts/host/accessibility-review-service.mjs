import { HostError } from './host-error.mjs';
import { buildChecks, summarizePdfKit } from './accessibility-review-checks.mjs';
import {
  accessibilityImageTargets,
  remediationPlan,
} from './accessibility-review-remediation-plan.mjs';
import { serializeAccessibilityReview } from './accessibility-review-report.mjs';
import { summarizeTagRoles } from './accessibility-review-tag-semantics.mjs';
import { reportSize } from './accessibility-review-utils.mjs';
export { AccessibilityColorContrastReviewService, createAccessibilityColorContrastReviewService } from './accessibility-color-contrast-service.mjs';

export const ACCESSIBILITY_REVIEW_PROFILE = 'basic-local-review';
export const ACCESSIBILITY_REVIEW_VERSION = 3;
export const DEFAULT_ACCESSIBILITY_REVIEW_LIMITS = Object.freeze({ maxPages: 200, maxReportBytes: 128 * 1024 });

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

/** Read-only, non-authoritative Poppler evidence review; it never mutates a PDF. */
export class AccessibilityReviewService {
  #store; #pdf; #pdfkit; #limits;

  constructor({ store, pdfService, pdfkitInspectionService = null, limits: configured } = {}) {
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') throw new TypeError('AccessibilityReviewService requires a DocumentStore-compatible store.');
    if (!pdfService || !['inspect', 'inspectStructure', 'listFonts', 'listImages', 'extractText'].every((name) => typeof pdfService[name] === 'function')) throw new TypeError('AccessibilityReviewService requires read-only PdfService inspection methods.');
    if (pdfkitInspectionService !== null && typeof pdfkitInspectionService?.inspect !== 'function') throw new TypeError('pdfkitInspectionService must expose inspect(documentId) when provided.');
    const limits = { ...DEFAULT_ACCESSIBILITY_REVIEW_LIMITS, ...(configured ?? {}) };
    if (!Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > DEFAULT_ACCESSIBILITY_REVIEW_LIMITS.maxPages || !Number.isSafeInteger(limits.maxReportBytes) || limits.maxReportBytes < 1024 || limits.maxReportBytes > DEFAULT_ACCESSIBILITY_REVIEW_LIMITS.maxReportBytes) throw new TypeError('Accessibility review limits must be bounded positive integers.');
    this.#store = store; this.#pdf = pdfService; this.#pdfkit = pdfkitInspectionService; this.#limits = Object.freeze(limits);
  }

  async review(documentId, { signal } = {}) {
    if (signal?.aborted) fail('JOB_CANCELLED', 'The local accessibility review was cancelled.', 499);
    const document = this.#store.getDocument(documentId); await this.#store.verifySource(documentId);
    const inspection = await this.#pdf.inspect(documentId, { signal });
    if (!Number.isSafeInteger(inspection?.pageCount) || inspection.pageCount < 1) fail('INVALID_ENGINE_OUTPUT', 'PDF inspection did not return a valid page count.', 502);
    if (inspection.pageCount > this.#limits.maxPages) fail('ACCESSIBILITY_PAGE_LIMIT', `Basic local accessibility review is limited to ${this.#limits.maxPages} pages.`, 422);
    const [structure, fonts, images, pages] = await Promise.all([this.#pdf.inspectStructure(documentId, { firstPage: 1, lastPage: inspection.pageCount, includeTagText: false, signal }), this.#pdf.listFonts(documentId, { signal }), this.#pdf.listImages(documentId, { signal }), this.#pdf.extractText(documentId, inspection.pageCount, { signal })]);
    if (!structure || structure.sourceDigest !== document.sha256 || !Array.isArray(fonts) || !Array.isArray(images) || !Array.isArray(pages) || pages.length !== inspection.pageCount) fail('INVALID_ENGINE_OUTPUT', 'Accessibility review evidence is incomplete or not bound to the immutable source.', 502);
    let pdfkitResult = null; let pdfkitAttempted = false; let pdfkitUnavailableReason = null;
    if (this.#pdfkit) { pdfkitAttempted = true; try { pdfkitResult = await this.#pdfkit.inspect(documentId, { signal }); } catch (error) { if (error?.code !== 'PDFKIT_DOCUMENT_UNSUPPORTED') throw error; pdfkitUnavailableReason = 'document-unsupported'; } }
    if (signal?.aborted) fail('JOB_CANCELLED', 'The local accessibility review was cancelled.', 499);
    await this.#store.verifySource(documentId);
    const taggedIndicator = String(inspection.tagged ?? '').toLowerCase() === 'yes'; const tagStructure = Boolean(structure?.taggedStructure?.present); const roles = summarizeTagRoles(structure); const pdfkit = summarizePdfKit(pdfkitResult, { sha256: document.sha256, pageCount: inspection.pageCount });
    const { checks, evidence } = buildChecks({ inspection, structure, fonts, images, pages, taggedIndicator, tagStructure, roles, pdfkit });
    const imageTargets = accessibilityImageTargets(document, images);
    const plan = remediationPlan({ document, checks, imageTargets, imageCount: images.length, roles, pdfkit });
    const report = serializeAccessibilityReview({ version: ACCESSIBILITY_REVIEW_VERSION, document, pageCount: inspection.pageCount, checks, evidence: { ...evidence, fonts: fonts.length, images: images.length, imageTargets }, roles, pdfkit, pdfkitAttempted, pdfkitUnavailableReason, plan });
    if (reportSize(report) > this.#limits.maxReportBytes) fail('ACCESSIBILITY_REPORT_LIMIT', 'The bounded accessibility report exceeded its local size limit.', 413);
    return report;
  }
}
