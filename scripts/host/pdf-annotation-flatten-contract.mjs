export const ANNOTATION_FLATTEN_PROFILE = 'local-square-annotation-flatten-v1';

function invalid() { const error = new Error('Annotation flatten request is invalid.'); error.code = 'INVALID_ANNOTATION_FLATTEN'; return error; }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Object.keys(value).some((key, index) => key !== keys[index]) || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true) || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

export function normalizeAnnotationFlatten(value) {
  const request = exact(value, ['profile', 'sourceSha256', 'target']); const target = exact(request.target, ['page', 'annotationIndex', 'fingerprint', 'subtype']);
  if (request.profile !== ANNOTATION_FLATTEN_PROFILE || typeof request.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(request.sourceSha256)
    || !Number.isSafeInteger(target.page) || target.page < 1 || target.page > 100
    || target.annotationIndex !== 0 || typeof target.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(target.fingerprint) || target.subtype !== 'square') throw invalid();
  return Object.freeze({ profile: ANNOTATION_FLATTEN_PROFILE, sourceSha256: request.sourceSha256, target: Object.freeze({ ...target }) });
}
