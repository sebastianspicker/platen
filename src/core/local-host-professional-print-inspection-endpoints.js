import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import {
  normalizeProfessionalPrintInspectionRequest,
  validateProfessionalPrintInspectionResponse,
} from './professional-print-inspection-contract.js';

function validOptions(options) {
  const keys = options?.signal === undefined ? [] : ['signal'];
  return exactObject(options, keys) && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function inspect(json, documentId, request, capabilityId, options) {
  if (typeof json !== 'function' || !OPAQUE_ID_PATTERN.test(documentId ?? '') || !validOptions(options)) {
    throw new TypeError('Professional print inspection options are invalid.');
  }
  const normalized = normalizeProfessionalPrintInspectionRequest(request, capabilityId);
  return json(`/api/documents/${encodeURIComponent(documentId)}/professional-print-inspection`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized), signal: options.signal,
  }).then((body) => validateProfessionalPrintInspectionResponse(body, normalized));
}

export function createProfessionalPrintInspectionEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Professional print inspection endpoints require JSON transport.');
  return Object.freeze({
    inspectPrintFonts(documentId, request, options = {}) {
      return inspect(json, documentId, request, 'print.font-inspection-embedding', options);
    },
    inspectPrintImages(documentId, request, options = {}) {
      return inspect(json, documentId, request, 'print.image-resolution-compression', options);
    },
  });
}
