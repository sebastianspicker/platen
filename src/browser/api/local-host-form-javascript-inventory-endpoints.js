import { validateFormJavaScriptInventoryResult } from '../../contracts/local-host-form-javascript-inventory-contract.js';
import { PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE } from '../../contracts/pdf-form-javascript-contract.mjs';
import { exactObject, OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

const SHA256 = /^[0-9a-f]{64}$/u;

function endpoint(json, documentId, sourceSha256, options) {
  const optionKeys = options?.signal === undefined ? [] : ['signal'];
  if (typeof json !== 'function' || !OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
    || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError('Form JavaScript inventory options are invalid.');
  }
  const request = Object.freeze({ profile: PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE, sourceSha256 });
  return postJson(json, documentEndpointPath(documentId, '/form-javascript-inventory'), request, options.signal)
    .then((body) => validateFormJavaScriptInventoryResult(body?.result, sourceSha256));
}

export function createFormJavaScriptInventoryEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Form JavaScript inventory endpoints require JSON transport.');
  const inspect = (documentId, sourceSha256, options = {}) => endpoint(json, documentId, sourceSha256, options);
  return Object.freeze({ inspectFormJavaScriptInventory: inspect, inspectPdfFormJavaScriptInventory: inspect });
}

export const createPdfFormJavaScriptInventoryEndpoints = createFormJavaScriptInventoryEndpoints;
