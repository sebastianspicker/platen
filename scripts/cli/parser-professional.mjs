import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

const SOURCE_BOUND_ACCESSIBILITY = new Set([
  'accessibility.form-semantics',
  'accessibility.table-semantics',
  'accessibility.links-bookmarks',
]);
const SOURCE_BOUND_PAGE_ORGANIZATION = new Set(['pages.page-boxes', 'pages.insert-blank']);
const SOURCE_BOUND_METADATA_EDIT = new Set(['document.metadata-edit']);
const SOURCE_BOUND_TEXT_EDIT = Object.freeze(new Set(['edit.text', 'edit.find-replace']));
const SOURCE_BOUND_HEADER_FOOTER_EDIT = Object.freeze(new Set(['edit.headers-footers']));
const DEDICATED_ENTRYPOINTS = Object.freeze(new Map([
  ['admin.audit-telemetry', 'the admin.audit-telemetry command'],
  ['admin.policy-configuration', 'the admin.policy-configuration command'],
  ['automation.api', 'the automation-submit commands'],
  ['create.clipboard-to-pdf', 'the browser clipboard PNG workflow'],
  ['create.cad-to-pdf', 'the create-cad-pdf-local command'],
  ['convert.html-to-pdf', 'the convert-html-local command'],
  ['document.attachments-manage', 'the attachment-removal workflow'],
  ['document.backgrounds', 'the page-background command'],
  ['document.bates-numbering', 'the bates-numbering command'],
  ['document.bookmarks-author', 'the PDFKit bookmark workflow'],
  ['document.destinations-author', 'the named-destination workflow'],
  ['document.embedded-files', 'the specialist-content inventory workflow'],
  ['document.layers-manage', 'the layer-defaults command'],
  ['document.watermarks', 'the page-watermark command'],
  ['create.postscript-to-pdf', 'the convert-postscript-local command'],
  ['create.print-to-pdf', 'the print-to-pdf-local command'],
  ['edit.add-text', 'the page-text workflow'],
  ['edit.images', 'the insert-jpeg or replace-jpeg command'],
  ['edit.text-reflow', 'the text-reflow command'],
  ['edit.vector-objects', 'the incremental page-vector workflow'],
  ['export.html-xml', 'the export-structured-local command'],
  ['export.images', 'the export-page-png-local command'],
  ['export.excel', 'the export-ooxml command'],
  ['export.powerpoint', 'the export-ooxml command'],
  ['export.selected-region', 'the snapshot-region command'],
  ['export.text-rtf', 'the export-structured-local command'],
  ['export.word', 'the export-ooxml command'],
  ['forms.javascript-actions', 'the local form JavaScript inventory workflow'],
  ['forms.static-to-fillable', 'the AcroForm text-field command'],
  ['forms.detect-fields', 'the local PDFKit widget-inventory workflow'],
  ['forms.author', 'the AcroForm checkbox, radio, or choice authoring workflows'],
  ['forms.xfa-compatibility', 'the local XFA-presence inspection workflow'],
  ['forms.fill-save', 'the authenticated local AcroForm fill/save derived-artifact workflow'],
  ['forms.validate', 'the authenticated read-only local AcroForm validation workflow'],
  ['ocr.batch-recognition', 'the ocr-batch command'],
  ['ocr.export-layout-preserving', 'the ocr-layout workflow'],
  ['ocr.language-detection-selection', 'the local OCR language-selection workflow'],
  ['ocr.recognize-text', 'the ocr command'],
  ['ocr.screenshot-capture', 'the browser clipboard PNG OCR workflow'],
  ['ocr.table-recognition', 'the review-grade OCR layout workflow'],
  ['ocr.zones-layout', 'the ocr-layout workflow'],
  ['review.annotation-import-export', 'the local source-bound XFDF interchange workflow'],
  ['review.annotation-properties', 'the local targeted PDFKit annotation workflow'],
  ['review.comments', 'the local PDFKit Text annotation workflow'],
  ['review.comments-to-office', 'the local comments-to-office export workflow'],
  ['review.drawing-markup', 'the local PDFKit line or ink annotation workflow'],
  ['review.file-audio-attachments', 'the local file-attachment workflow'],
  ['review.markup-tools', 'the authenticated local PDFKit derived-copy mutation workflow'],
  ['review.measurements', 'the local review-measurement workflow'],
  ['review.notifications-mentions', 'the local review-notification workflow'],
  ['review.shared-review', 'the local review-exchange workflow'],
  ['review.statuses', 'the local review sidecar status workflow'],
  ['review.text-markup', 'the authenticated local PDFKit derived-copy mutation workflow'],
  ['review.text-notes-callouts', 'the authenticated local PDFKit derived-copy mutation workflow'],
  ['optimize.compress', 'the optimize-compress-local command'],
  ['review.filter-sort', 'the local review sidecar inspection workflow'],
  ['review.comment-summary', 'the local review sidecar inspection workflow'],
  ['review.review-tracking', 'the local review sidecar inspection workflow'],
  ['sign.electronic', 'the authenticated local electronic signing-intent workflow'],
  ['sign.validate-certificate', 'the authenticated offline signature review and macOS current-trust path workflow'],
  ['platform.plugins.dependency-resolution', 'the authenticated plugin-package workflow'],
  ['platform.plugins.install', 'the authenticated plugin-package workflow'],
  ['platform.plugins.lifecycle', 'the authenticated plugin-package workflow'],
  ['platform.plugins.registry', 'the authenticated plugin-package workflow'],
  ['platform.plugins.upgrade-rollback', 'the authenticated plugin-package workflow'],
]));

function parseProfessionalSourceBoundCapability(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const request = values.get('request');
  if (!request || !output || !/\.json$/iu.test(request) || !/\.pdf$/iu.test(output)) {
    fail('CLI_INVALID_OPTION', 'Source-bound professional capability requires INPUT.pdf, --request REQUEST.json, and --output OUTPUT.pdf.');
  }
  return Object.freeze({
    command,
    capabilityId: values.get('capability-id'),
    input: boundedPath(input, 'Input'),
    requestPath: boundedPath(request, 'Request'),
    output: boundedPath(output, 'Output'),
  });
}

export function parseProfessionalCapability(command, positionals, values, output) {
  const capabilityId = values.get('capability-id');
  if (!capabilityId) fail('CLI_INVALID_OPTION', 'professional-capability requires --capability-id.');
  if (DEDICATED_ENTRYPOINTS.has(capabilityId)) {
    fail('CLI_DEDICATED_CAPABILITY_ENTRYPOINT', `${capabilityId} is available only through ${DEDICATED_ENTRYPOINTS.get(capabilityId)}.`);
  }
  if (
    SOURCE_BOUND_ACCESSIBILITY.has(capabilityId)
    || SOURCE_BOUND_PAGE_ORGANIZATION.has(capabilityId)
    || SOURCE_BOUND_METADATA_EDIT.has(capabilityId)
    || SOURCE_BOUND_TEXT_EDIT.has(capabilityId)
    || SOURCE_BOUND_HEADER_FOOTER_EDIT.has(capabilityId)
  ) {
    return parseProfessionalSourceBoundCapability(command, positionals, values, output);
  }
  exactPositionals(positionals, 0);
  if (values.has('request')) fail('CLI_INVALID_OPTION', '--request is only supported for source-bound professional capabilities.');
  return Object.freeze({ command, capabilityId, context: {}, output });
}
