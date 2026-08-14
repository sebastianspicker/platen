export const PDF_FAST_WEB_VIEW_PROFILE = 'local-pdf-fast-web-view-v1';
export const PDF_FAST_WEB_VIEW_LIMITATIONS = Object.freeze([
  'The output is linearized only when qpdf independently accepts its linearization dictionary and hint tables.',
  'Linearization evidence does not guarantee delivery behavior for every HTTP server, cache, or PDF consumer.',
  'The immutable source remains unchanged; the result is a separate derived artifact.',
]);
export const PDF_FAST_WEB_VIEW_VALIDATORS = Object.freeze([
  'source-sha256', 'private-workspace', 'qpdf-linearize',
  'qpdf-check-linearization', 'linearization-dictionary', 'artifact-sha256',
]);

function invalid() {
  const error = new Error('The PDF fast-web-view request is outside the supported profile.');
  error.code = 'INVALID_PDF_FAST_WEB_VIEW';
  return error;
}

export function normalizePdfFastWebView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'profile'
    || !descriptors.profile || !descriptors.profile.enumerable
    || !Object.hasOwn(descriptors.profile, 'value')
    || descriptors.profile.value !== PDF_FAST_WEB_VIEW_PROFILE) throw invalid();
  return Object.freeze({ profile: PDF_FAST_WEB_VIEW_PROFILE });
}

export function pdfFastWebViewFailure() { return invalid(); }

