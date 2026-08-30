import { validatePdfXfaInspectionResult } from '../../contracts/local-host-xfa-inspection-contract.js';
import { PDF_XFA_INSPECTION_PROFILE } from '../../contracts/pdf-xfa-inspection-contract.mjs';
import { exactObject, OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

const SHA256 = /^[0-9a-f]{64}$/u;

function endpoint(json, documentId, sourceSha256, options) {
  const optionKeys = options?.signal === undefined ? [] : ['signal'];
  if (typeof json !== 'function' || !OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
    || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError('XFA inspection options are invalid.');
  }
  const request = Object.freeze({ profile: PDF_XFA_INSPECTION_PROFILE, sourceSha256 });
  return postJson(json, documentEndpointPath(documentId, '/xfa-inspection'), request, options.signal)
    .then((body) => validatePdfXfaInspectionResult(body?.result, sourceSha256));
}

export function createPdfXfaInspectionEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('XFA inspection endpoints require JSON transport.');
  const inspect = (documentId, sourceSha256, options = {}) => endpoint(json, documentId, sourceSha256, options);
  return Object.freeze({ inspectPdfXfaPresence: inspect, inspectXfaPresence: inspect });
}
