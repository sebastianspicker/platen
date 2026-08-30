import {
  PDF_FAST_WEB_VIEW_LIMITATIONS,
  PDF_FAST_WEB_VIEW_PROFILE,
  PDF_FAST_WEB_VIEW_VALIDATORS,
} from '../../../contracts/pdf-fast-web-view-contract.js';

export {
  PDF_FAST_WEB_VIEW_LIMITATIONS,
  PDF_FAST_WEB_VIEW_PROFILE,
  PDF_FAST_WEB_VIEW_VALIDATORS,
};

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
