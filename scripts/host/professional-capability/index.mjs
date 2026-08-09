import { handlers as view_navigation } from './view-navigation.mjs';
import { handlers as create_convert } from './create-convert.mjs';
import { handlers as content_editing } from './content-editing.mjs';
import { handlers as page_organization } from './page-organization.mjs';
import { handlers as annotations_review } from './annotations-review.mjs';
import { handlers as forms } from './forms.mjs';
import { handlers as signatures } from './signatures.mjs';
import { handlers as scan_ocr } from './scan-ocr.mjs';
import { handlers as security } from './security.mjs';
import { handlers as redaction_sanitization } from './redaction-sanitization.mjs';
import { handlers as comparison } from './comparison.mjs';
import { handlers as accessibility } from './accessibility.mjs';
import { handlers as standards_preflight_print } from './standards-preflight-print.mjs';
import { handlers as collaboration_dms } from './collaboration-dms.mjs';
import { handlers as automation_headless } from './automation-headless.mjs';
import { handlers as ai } from './local-ai.mjs';
import { handlers as aec } from './aec.mjs';
import { handlers as rich_media_3d_portfolios } from './rich-media-3d-portfolios.mjs';
import { handlers as integrations_admin } from './integrations-admin.mjs';
import { handlers as plugin_platform } from './plugin-platform.mjs';

const ALL = Object.freeze({
  ...view_navigation,
  ...create_convert,
  ...content_editing,
  ...page_organization,
  ...annotations_review,
  ...forms,
  ...signatures,
  ...scan_ocr,
  ...security,
  ...redaction_sanitization,
  ...comparison,
  ...accessibility,
  ...standards_preflight_print,
  ...collaboration_dms,
  ...automation_headless,
  ...ai,
  ...aec,
  ...rich_media_3d_portfolios,
  ...integrations_admin,
  ...plugin_platform,
});

const DEDICATED_ENTRYPOINTS = Object.freeze(new Map([
  ['admin.audit-telemetry', 'the admin.audit-telemetry command'],
  ['automation.api', 'the automation-submit commands'],
  ['create.clipboard-to-pdf', 'the browser clipboard PNG workflow'],
  ['create.cad-to-pdf', 'the create-cad-pdf-local command'],
  ['convert.html-to-pdf', 'the convert-html-local command'],
  ['create.postscript-to-pdf', 'the convert-postscript-local command'],
  ['create.print-to-pdf', 'the print-to-pdf-local command'],
  ['document.embedded-files', 'the specialist-content inventory workflow'],
  ['export.excel', 'the export-ooxml command'],
  ['export.html-xml', 'the export-structured-local command'],
  ['export.images', 'the export-page-png-local command'],
  ['export.powerpoint', 'the export-ooxml command'],
  ['export.selected-region', 'the snapshot-region command'],
  ['export.text-rtf', 'the export-structured-local command'],
  ['export.word', 'the export-ooxml command'],
  ['forms.import-export-data', 'the authenticated AcroForm CSV export route'],
  ['ocr.batch-recognition', 'the ocr-batch command'],
  ['ocr.export-layout-preserving', 'the ocr-layout workflow'],
  ['ocr.language-detection-selection', 'the local OCR language-selection workflow'],
  ['ocr.recognize-text', 'the ocr command'],
  ['ocr.screenshot-capture', 'the browser clipboard PNG OCR workflow'],
  ['ocr.table-recognition', 'the review-grade OCR layout workflow'],
  ['ocr.zones-layout', 'the ocr-layout workflow'],
  ['optimize.compress', 'the optimize-compress-local command'],
  ['platform.plugins.dependency-resolution', 'the authenticated plugin-package workflow'],
  ['platform.plugins.install', 'the authenticated plugin-package workflow'],
  ['platform.plugins.lifecycle', 'the authenticated plugin-package workflow'],
  ['platform.plugins.registry', 'the authenticated plugin-package workflow'],
  ['platform.plugins.upgrade-rollback', 'the authenticated plugin-package workflow'],
]));

export function listProfessionalHandlers() {
  return Object.freeze(Object.keys(ALL).filter((id) => !DEDICATED_ENTRYPOINTS.has(id)).sort());
}

export function getProfessionalHandler(capabilityId) {
  if (DEDICATED_ENTRYPOINTS.has(capabilityId)) {
    const error = new Error(`${capabilityId} is available only through ${DEDICATED_ENTRYPOINTS.get(capabilityId)}.`);
    error.code = 'PROFESSIONAL_DEDICATED_CAPABILITY_ENTRYPOINT';
    error.status = 403;
    throw error;
  }
  const handler = ALL[capabilityId];
  if (typeof handler !== 'function') {
    const error = new Error(`No professional handler for ${capabilityId}`);
    error.code = 'PROFESSIONAL_HANDLER_MISSING';
    throw error;
  }
  return handler;
}

export async function deliverProfessionalCapability(capabilityId, context = {}) {
  return getProfessionalHandler(capabilityId)(context);
}

export { ALL as professionalHandlers };
