import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const PROFILE = 'local-pdf-jpeg-image-v1';

function normalizeRect(value) {
  if (!exactObject(value, ['x', 'y', 'width', 'height'])) throw new TypeError('JPEG image rectangle is invalid.');
  const rect = {};
  for (const [key, minimum] of [['x', -1_000_000], ['y', -1_000_000], ['width', 0], ['height', 0]]) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || Object.is(number, -0) || number < minimum || number > 1_000_000 || (!Number.isSafeInteger(number) && Number.isInteger(number))) throw new TypeError('JPEG image rectangle is invalid.');
    const rounded = Math.round(number * 1_000_000) / 1_000_000;
    if (rounded <= minimum && minimum >= 0) throw new TypeError('JPEG image rectangle is invalid.');
    rect[key] = rounded;
  }
  return Object.freeze(rect);
}

export function createJpegImageEndpoints({ json }) {
  return Object.freeze({
    insertJpegImage(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('JPEG image options are invalid.');
      if (!exactObject(request, ['profile', 'sourceSha256', 'inputId', 'inputSha256', 'page', 'rect']) || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !OPAQUE_ID_PATTERN.test(request.inputId ?? '') || !SHA256.test(request.inputSha256 ?? '') || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 10_000) throw new TypeError('JPEG image request is invalid.');
      const fixed = Object.freeze({ ...request, rect: normalizeRect(request.rect) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/insert-jpeg`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixed), signal: options.signal }).then((body) => body?.result);
    },
  });
}
