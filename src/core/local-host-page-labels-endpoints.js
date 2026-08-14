import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u; const PROFILE = 'local-page-labels-v1';
function validateRanges(ranges) {
  let previous = -1;
  for (const range of ranges) {
    if (!range || typeof range !== 'object' || Array.isArray(range) || Object.getPrototypeOf(range) !== Object.prototype || Object.keys(range).some((key) => !['start', 'style', 'prefix', 'startNumber'].includes(key)) || !Object.hasOwn(range, 'start') || !Object.hasOwn(range, 'style') || !Number.isSafeInteger(range.start) || range.start < 0 || range.start <= previous || !['D', 'R', 'r', 'A', 'a', 'none'].includes(range.style)) throw new TypeError('Page-label ranges are invalid.');
    if (range.prefix !== undefined && (typeof range.prefix !== 'string' || range.prefix !== range.prefix.normalize('NFC') || /[\u0000-\u001f\u007f\u0080-\u009f\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(range.prefix) || new TextEncoder().encode(range.prefix).length > 256)) throw new TypeError('Page-label ranges are invalid.');
    const hasNumber = Object.hasOwn(range, 'startNumber'); if (range.style === 'none' ? hasNumber : (!hasNumber || !Number.isSafeInteger(range.startNumber) || range.startNumber < 1 || range.startNumber > 1_000_000)) throw new TypeError('Page-label ranges are invalid.'); previous = range.start;
  }
}
export function createPageLabelsEndpoints({ json }) {
  return Object.freeze({
    createPageLabels(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Page-label options are invalid.');
      if (!exactObject(request, ['profile', 'sourceSha256', 'ranges']) || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !Array.isArray(request.ranges) || request.ranges.length < 1 || request.ranges.length > 20) throw new TypeError('Page-label request is invalid.');
      validateRanges(request.ranges);
      const body = Object.freeze({ ...request, ranges: Object.freeze(request.ranges.map((range) => Object.freeze({ ...range }))) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/page-labels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options.signal }).then((value) => value?.result);
    },
  });
}
