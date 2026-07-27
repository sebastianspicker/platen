export const PDF_TEXT_EDIT_PROFILE = 'local-pdf-text-edit-v1';
export const PDF_FIND_REPLACE_PROFILE = PDF_TEXT_EDIT_PROFILE;
export const PDF_TEXT_EDIT_LIMITS = Object.freeze({
  maxPages: 10_000,
  maxTextBytes: 512,
});

function invalid(message = 'PDF text-edit request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_TEXT_EDIT';
  return error;
}

function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  const keys = [...required, ...optional];
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    throw invalid();
  }
  if (Object.values(descriptors).some((descriptor) => (
    !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
  ))) throw invalid();
  return Object.fromEntries(Object.keys(descriptors).map((key) => [key, descriptors[key].value]));
}

function text(value, label) {
  if (typeof value !== 'string' || value.length < 1
    || Buffer.byteLength(value, 'latin1') > PDF_TEXT_EDIT_LIMITS.maxTextBytes
    || !/^[\x20-\x7e]+$/u.test(value) || /[\\()]/u.test(value)) {
    throw invalid(`${label} must be bounded printable ASCII text.`);
  }
  return value;
}

function page(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > PDF_TEXT_EDIT_LIMITS.maxPages) throw invalid();
  return value;
}

function digest(value) {
  if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))) throw invalid();
  return value;
}

export function normalizePdfTextEditRequest(value = {}) {
  const request = exactObject(value, ['profile', 'page', 'find', 'replace'], ['sourceSha256']);
  if (request.profile !== PDF_TEXT_EDIT_PROFILE) throw invalid();
  const find = text(request.find, 'find');
  const replace = text(request.replace, 'replace');
  if (Buffer.byteLength(find, 'latin1') !== Buffer.byteLength(replace, 'latin1')) {
    throw invalid('find and replace must have the same encoded byte length.');
  }
  return Object.freeze({
    profile: PDF_TEXT_EDIT_PROFILE,
    page: page(request.page),
    find,
    replace,
    ...(request.sourceSha256 === undefined ? {} : { sourceSha256: digest(request.sourceSha256) }),
  });
}

export const normalizeTextEditRequest = normalizePdfTextEditRequest;
export const normalizePdfFindReplaceRequest = normalizePdfTextEditRequest;
