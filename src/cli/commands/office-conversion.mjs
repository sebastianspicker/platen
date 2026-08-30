import { runLibreOfficeConversionCommand } from './libreoffice-conversion-command.mjs';

const PROFILE = Object.freeze({
  invalidCode: 'CLI_INVALID_OFFICE_CONVERSION',
  operationType: 'office-to-pdf', sourceFormat: 'odt', sourceKind: 'office',
  extension: '.odt', mediaType: 'application/vnd.oasis.opendocument.text',
  minimumInputBytes: 4, maxInputBytes: 64 * 1024 * 1024, maxPdfBytes: 256 * 1024 * 1024,
  maxPages: 32, maxTextBytes: 8 * 1024 * 1024, exportMethod: 'prepareOfficePdfExport',
  inputRecordMessage: 'The private ODT input record is inconsistent.',
  invalidProvenanceMessage: 'Office conversion returned invalid operation provenance.',
  provenanceMessage: 'Office conversion provenance does not match the fixed local profile.',
  noBytesMessage: 'The office PDF export did not return bounded PDF bytes.',
  evidenceMessage: 'The office PDF export failed the fixed independent checks.',
  receiptMessage: 'The published PDF receipt does not match the validated derived bytes.',
  pageCountMessage: 'Office PDF page count changed after conversion.',
  cleanupMessage: 'Office conversion failed and its private derived document could not be revoked.',
  cleanupAggregateMessage: 'Office conversion and derived document cleanup failed.',
  fidelityExclusions: Object.freeze([
    'Exact visual, pagination, font, and layout fidelity is not certified.',
    'Interactive office features, macros, and unsupported embedded content are not preserved.',
  ]),
});

export function runOfficeConversionCommand(application, command, stdout, signal, runtime) {
  return runLibreOfficeConversionCommand(application, command, stdout, signal, runtime, PROFILE);
}
