export const PDFKIT_MAX_RESPONSE_BYTES = 524_288;

const helperErrorCodes = new Set([
  'INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'UNSAFE_WORKSPACE', 'INPUT_TOO_LARGE',
  'UNREADABLE_DOCUMENT', 'RESPONSE_TOO_LARGE', 'OUTPUT_EXISTS',
  'OUTPUT_WRITE_FAILED', 'MUTATION_FAILED', 'OUTPUT_INVALID',
]);

export function responseError(code = 'INVALID_RESPONSE') {
  const error = new Error(`PDFKit helper returned ${code}`);
  error.code = code;
  return error;
}

export function isBoolean(value) { return typeof value === 'boolean'; }
export function isInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
export function isNullableString(value) { return value === null || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 1_024); }
export function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
export function isFingerprint(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export function isOpaqueIdentifier(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }

export const annotationTypes = new Set([
  'text', 'link', 'freeText', 'line', 'square', 'circle', 'highlight', 'underline',
  'strikeOut', 'ink', 'stamp', 'popup', 'widget', 'unknown',
]);

export function parsePdfkitEnvelope(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > PDFKIT_MAX_RESPONSE_BYTES) {
    throw responseError('RESPONSE_TOO_LARGE');
  }
  let response;
  try { response = JSON.parse(stdout); } catch { throw responseError(); }
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || !isInteger(response.version, 1, 1) || !isBoolean(response.ok)) throw responseError();
  if (!response.ok) {
    if (Object.keys(response).length !== 3 || !response.error || Object.keys(response.error).length !== 1
      || !helperErrorCodes.has(response.error.code)) throw responseError();
    throw responseError(response.error.code);
  }
  if (Object.keys(response).length !== 3) throw responseError();
  return response.result;
}
