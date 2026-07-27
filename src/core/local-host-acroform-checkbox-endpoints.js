import { exactObject, OPAQUE_ID_PATTERN, validPdfKitRectangle } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const PROFILE = 'local-pdf-acroform-checkbox-v1';

function text(value, min, max) {
  return typeof value === 'string' && value === value.normalize('NFC') && [...value].length >= min && [...value].length <= max && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}

export function createAcroFormCheckboxEndpoints({ json }) {
  return Object.freeze({
    addAcroFormCheckbox(documentId, request, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, options?.signal === undefined ? [] : ['signal']) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('AcroForm checkbox options are invalid.');
      if (!exactObject(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect']) || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 10000 || !text(request.fieldName, 1, 127) || !validPdfKitRectangle(request.rect)) throw new TypeError('AcroForm checkbox request is invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/acroform-checkbox`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal }).then((body) => body?.result);
    },
  });
}

