import { prepareLibreOfficeDerivedPdfExport } from './libreoffice-derived-pdf-export.mjs';

export const MAX_HTML_PDF_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_HTML_PDF_EXPORT_PAGES = 32;

const PROFILE = Object.freeze({
  label: 'HTML',
  operationType: 'html-to-pdf',
  sourceFormat: 'html',
  sourceKind: 'html',
  invalidCode: 'INVALID_HTML_PDF_DOCUMENT',
  maxBytes: MAX_HTML_PDF_EXPORT_BYTES,
  maxPages: MAX_HTML_PDF_EXPORT_PAGES,
  maxTextBytes: 8 * 1024 * 1024,
  provenanceMessage: 'Only a LibreOffice-produced HTML-derived PDF can be exported.',
  bindingMessage: 'HTML-to-PDF export could not bind the derived PDF to a private snapshot.',
  driftMessage: 'HTML-to-PDF export snapshot changed during validation.',
  passiveMessage: 'HTML-to-PDF export requires a passive, unencrypted PDF without JavaScript or forms.',
  textCoverageMessage: 'HTML-to-PDF text extraction did not cover pages sequentially.',
  textLimitCode: 'HTML_PDF_TEXT_LIMIT',
  textLimitMessage: 'HTML-to-PDF text evidence exceeds the bounded export limit.',
  sizeMessage: 'The derived HTML PDF is outside the bounded export size.',
  snapshotName: 'immutable-html-pdf-source.pdf',
  snapshotLabel: 'Derived HTML PDF snapshot',
  byteMismatchMessage: 'HTML-to-PDF export bytes do not match the derived document record.',
  pageLimitCode: 'HTML_PDF_PAGE_LIMIT',
  pageLimitMessage: 'HTML-to-PDF export is limited to 32 pages.',
});

export function prepareHtmlPdfDocumentExport(options) {
  return prepareLibreOfficeDerivedPdfExport({ ...options, profile: PROFILE });
}
