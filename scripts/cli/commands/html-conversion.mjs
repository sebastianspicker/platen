import { assertInlineOnlyHtml } from '../../host/conversion-admission.mjs';
import { runLibreOfficeConversionCommand } from './libreoffice-conversion-command.mjs';

const PROFILE = Object.freeze({
  invalidCode: 'CLI_INVALID_HTML_CONVERSION',
  operationType: 'html-to-pdf', sourceFormat: 'html', sourceKind: 'html',
  extension: '.html', mediaType: 'text/html',
  minimumInputBytes: 1, maxInputBytes: 8 * 1024 * 1024, maxPdfBytes: 64 * 1024 * 1024,
  maxPages: 32, maxTextBytes: 8 * 1024 * 1024, exportMethod: 'prepareHtmlPdfExport',
  assertInput: assertInlineOnlyHtml,
  inputRecordMessage: 'The private HTML input record is inconsistent.',
  invalidProvenanceMessage: 'HTML conversion returned invalid operation provenance.',
  provenanceMessage: 'HTML conversion provenance does not match the fixed local profile.',
  noBytesMessage: 'The HTML PDF export did not return bounded PDF bytes.',
  evidenceMessage: 'The HTML PDF export failed the fixed independent checks.',
  receiptMessage: 'The published PDF receipt does not match the validated derived bytes.',
  pageCountMessage: 'HTML PDF page count changed after conversion.',
  cleanupMessage: 'HTML conversion failed and its private derived document could not be revoked.',
  cleanupAggregateMessage: 'HTML conversion and derived document cleanup failed.',
  fidelityExclusions: Object.freeze([
    'Exact visual, pagination, font, and layout fidelity is not certified.',
    'Attributes, CSS, external resources, scripts, forms, and active HTML content are not accepted.',
  ]),
});

export function runHtmlConversionCommand(application, command, stdout, signal, runtime) {
  return runLibreOfficeConversionCommand(application, command, stdout, signal, runtime, PROFILE);
}
