import { exactObject, OPAQUE_ID_PATTERN, validPdfKitRectangle } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const PROFILE = 'local-pdf-acroform-radio-v1';
function text(value, min, max) { return typeof value === 'string' && value === value.normalize('NFC') && [...value].length >= min && [...value].length <= max && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value); }
function validOptions(options) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 10 || !options.every((entry) => exactObject(entry, ['label', 'page', 'rect']) && text(entry.label, 1, 127) && Number.isSafeInteger(entry.page) && entry.page >= 1 && entry.page <= 10000 && validPdfKitRectangle(entry.rect))) return false;
  const labels = new Set(options.map((entry) => entry.label));
  const rects = new Set(options.map((entry) => `${entry.page}\u0000${entry.rect.x},${entry.rect.y},${entry.rect.width},${entry.rect.height}`));
  return labels.size === options.length && rects.size === options.length;
}
export function createAcroFormRadioEndpoints({ json }) {
  return Object.freeze({
    addAcroFormRadio(documentId, request, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, options?.signal === undefined ? [] : ['signal']) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('AcroForm radio options are invalid.');
      if (!exactObject(request, ['profile', 'sourceSha256', 'groupName', 'options']) || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !text(request.groupName, 1, 127) || !validOptions(request.options)) throw new TypeError('AcroForm radio request is invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/acroform-radio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal }).then((body) => body?.result);
    },
  });
}
