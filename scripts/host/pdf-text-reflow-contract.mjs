import { isProxy } from 'node:util/types';

export const PDF_TEXT_REFLOW_PROFILE = 'local-pdf-text-reflow-v1';
export const PDF_TEXT_REFLOW_LIMITS = Object.freeze({ maxPages: 10_000, maxLines: 32, maxLineWidth: 128, maxTextBytes: 4_096 });
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(message = 'PDF text-reflow request is invalid.') { const error = new Error(message); error.code = 'INVALID_PDF_TEXT_REFLOW'; return error; }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`${label} must be a plain data object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value); const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid(`${label} has unsupported fields.`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function integer(value, label, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(`${label} is out of bounds.`); return value; }
function reference(value) { const item = exact(value, ['object', 'generation'], 'streamRef'); return Object.freeze({ object: integer(item.object, 'streamRef.object', 1, 1_000_000), generation: integer(item.generation, 'streamRef.generation', 0, 65_535) }); }
function indices(value) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid('lineTokenIndices must be a dense array.');
  const descriptors = Object.getOwnPropertyDescriptors(value); const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 2 || length > PDF_TEXT_REFLOW_LIMITS.maxLines || Reflect.ownKeys(value).length !== length + 1) throw invalid('lineTokenIndices is outside its fixed bound.');
  const result = []; for (let index = 0; index < length; index += 1) { const descriptor = descriptors[index]; if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid('lineTokenIndices must be dense.'); result.push(integer(descriptor.value, 'line token index', 0, 200_000)); }
  if (result.some((item, index) => index > 0 && item <= result[index - 1])) throw invalid('lineTokenIndices must be strictly increasing.'); return Object.freeze(result);
}
function replacement(value) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'ascii') > PDF_TEXT_REFLOW_LIMITS.maxTextBytes || !/^[\x20-\x7e]+$/u.test(value) || /[\\()]/u.test(value) || value.trim() !== value || /\s{2,}/u.test(value)) throw invalid('replacementText must be canonical bounded printable ASCII.');
  return value;
}

export function normalizePdfTextReflowRequest(value) {
  const request = exact(value, ['profile', 'sourceSha256', 'page', 'streamRef', 'lineTokenIndices', 'lineWidth', 'originalTextSha256', 'replacementText'], 'text-reflow request');
  if (request.profile !== PDF_TEXT_REFLOW_PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !SHA256.test(request.originalTextSha256 ?? '')) throw invalid();
  return Object.freeze({ profile: PDF_TEXT_REFLOW_PROFILE, sourceSha256: request.sourceSha256, page: integer(request.page, 'page', 1, PDF_TEXT_REFLOW_LIMITS.maxPages), streamRef: reference(request.streamRef), lineTokenIndices: indices(request.lineTokenIndices), lineWidth: integer(request.lineWidth, 'lineWidth', 4, PDF_TEXT_REFLOW_LIMITS.maxLineWidth), originalTextSha256: request.originalTextSha256, replacementText: replacement(request.replacementText) });
}
