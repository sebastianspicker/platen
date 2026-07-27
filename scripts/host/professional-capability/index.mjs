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

export function listProfessionalHandlers() {
  return Object.freeze(Object.keys(ALL).sort());
}

export function getProfessionalHandler(capabilityId) {
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
