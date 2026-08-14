import { spreadsheetSafeCsvCell } from '../../../src/core/spreadsheet-safe-csv.js';
import { boundedString, createServiceOptions, requireObject, requireWorkspace } from './trust-accessibility-support.mjs';

function asCsv(records) {
  const fields = ['id', 'rule', 'severity', 'pageNumber', 'message', 'status'];
  return [fields.join(','), ...records.map((record) => fields.map(
    (field) => spreadsheetSafeCsvCell(record[field]),
  ).join(','))].join('\n');
}

/** Owns inspection, export, and proposed-only accessibility remediation records. */
export class AccessibilityDomainService {
  #workspace;
  #clock;
  #idFactory;

  constructor(workspace, options = {}) {
    this.#workspace = requireWorkspace(workspace);
    ({ clock: this.#clock, idFactory: this.#idFactory } = createServiceOptions(options));
  }

  inspectAccessibility(summary = {}) {
    requireObject(summary, 'accessibility summary');
    const issues = [];
    const add = (rule, severity, message, pageNumber) => issues.push({ id: `a11y-${issues.length + 1}`, rule, severity, message, pageNumber: pageNumber ?? '', status: 'open' });
    if (summary.tagged !== true) add('tagged-pdf', 'error', 'Document is not reported as tagged.');
    if (!summary.title) add('document-title', 'warning', 'Document title is missing.');
    if (!summary.language) add('document-language', 'warning', 'Document language is missing.');
    if (summary.unicodeMapped === false) add('unicode-mapping', 'error', 'Text Unicode mapping is incomplete.');
    if (summary.fontsEmbedded === false) add('font-embedding', 'warning', 'One or more fonts are not embedded.');
    for (const page of summary.pages ?? []) if (page.empty === true) add('empty-page', 'warning', 'Page has no readable text.', page.pageNumber);
    for (const image of summary.images ?? []) if (!image.altText) add('image-alt-text', 'error', 'Image lacks alternative text.', image.pageNumber);
    for (const field of summary.forms ?? []) if (!field.label) add('form-label', 'error', 'Form field lacks a label.', field.pageNumber);
    for (const issue of summary.readingOrderIssues ?? []) add('reading-order', 'error', typeof issue === 'string' ? issue : 'Reading-order issue reported.', issue?.pageNumber);
    return Object.freeze({ status: 'inspection-only', issues: Object.freeze(issues), summary: Object.freeze({ issueCount: issues.length, conformsPdfUa: false }) });
  }

  exportAccessibilityReport(report, format = 'json') {
    requireObject(report, 'report');
    if (format === 'json') return JSON.stringify(report);
    if (format === 'csv') return asCsv(report.issues ?? []);
    throw new TypeError('Accessibility export format must be json or csv.');
  }

  proposeAccessibilityRemediation(documentId, summary, { expectedRevision } = {}) {
    const report = this.inspectAccessibility(summary);
    const tagId = this.#idFactory('accessibility-proposal');
    const proposal = { id: tagId, type: 'accessibility-proposal', createdAtLocal: this.#localTime(), status: 'proposed-not-applied', proposedTagTree: summary.proposedTagTree ?? [], readingOrder: summary.readingOrder ?? [], headings: summary.headings ?? [], lists: summary.lists ?? [], tables: summary.tables ?? [], formSemantics: summary.formSemantics ?? [], links: summary.links ?? [], bookmarks: summary.bookmarks ?? [], artifacts: summary.artifacts ?? [], altText: summary.altText ?? [], language: summary.language ?? null, title: summary.title ?? null, contrastReviews: summary.contrastReviews ?? [], pdfWriterRequired: true };
    const first = this.#workspace.createEntity(documentId, 'accessibilityTags', proposal, { expectedRevision });
    const issueRecord = { id: this.#idFactory('accessibility-report'), type: 'accessibility-report', createdAtLocal: this.#localTime(), status: 'inspection-only', issues: report.issues, remediationProposalId: tagId };
    return this.#workspace.createEntity(documentId, 'accessibilityIssues', issueRecord, { expectedRevision: first.revision });
  }

  #localTime() { return boundedString(this.#clock(), 'clock value', 128); }
}
