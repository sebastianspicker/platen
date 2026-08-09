import { prepareLibreOfficeDerivedPdfExport } from './libreoffice-derived-pdf-export.mjs';

export const MAX_OFFICE_PDF_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_OFFICE_PDF_EXPORT_PAGES = 32;

const PROFILE = Object.freeze({
  label: 'Office',
  operationType: 'office-to-pdf',
  sourceFormat: 'odt',
  sourceKind: 'office',
  invalidCode: 'INVALID_OFFICE_PDF_DOCUMENT',
  maxBytes: MAX_OFFICE_PDF_EXPORT_BYTES,
  maxPages: MAX_OFFICE_PDF_EXPORT_PAGES,
  maxTextBytes: 8 * 1024 * 1024,
  provenanceMessage: 'Only a LibreOffice-produced ODT-derived PDF can be exported.',
  bindingMessage: 'Office-to-PDF export could not bind the derived PDF to a private snapshot.',
  driftMessage: 'Office-to-PDF export snapshot changed during validation.',
  passiveMessage: 'Office-to-PDF export requires a passive, unencrypted PDF without JavaScript or forms.',
  textCoverageMessage: 'Office-to-PDF text extraction did not cover pages sequentially.',
  textLimitCode: 'OFFICE_PDF_TEXT_LIMIT',
  textLimitMessage: 'Office-to-PDF text evidence exceeds the bounded export limit.',
  sizeMessage: 'The derived Office PDF is outside the bounded export size.',
  snapshotName: 'immutable-office-pdf-source.pdf',
  snapshotLabel: 'Derived Office PDF snapshot',
  byteMismatchMessage: 'Office-to-PDF export bytes do not match the derived document record.',
  pageLimitCode: 'OFFICE_PDF_PAGE_LIMIT',
  pageLimitMessage: 'Office-to-PDF export is limited to 32 pages.',
});

export function prepareOfficePdfDocumentExport(options) {
  return prepareLibreOfficeDerivedPdfExport({ ...options, profile: PROFILE });
}
