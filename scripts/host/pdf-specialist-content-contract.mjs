export const PDF_SPECIALIST_CONTENT_PROFILE = 'local-pdf-specialist-content-v1';
export const SPECIALIST_CONTENT_PROFILE = PDF_SPECIALIST_CONTENT_PROFILE;
const SHA256 = /^[0-9a-f]{64}$/u;
function invalid(message = 'PDF specialist-content request is invalid.') { const error = new Error(message); error.code = 'INVALID_PDF_SPECIALIST_CONTENT'; return error; }
function exactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('profile') || !keys.includes('sourceSha256') || Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value') || d.enumerable !== true)) throw invalid();
  return descriptors;
}
export function normalizePdfSpecialistContent(value) {
  const request = exactObject(value);
  if (request.profile.value !== PDF_SPECIALIST_CONTENT_PROFILE || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  return Object.freeze({ profile: PDF_SPECIALIST_CONTENT_PROFILE, sourceSha256: request.sourceSha256.value });
}
export const normalizeSpecialistContent = normalizePdfSpecialistContent;
