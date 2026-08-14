import {
  MAX_NATIVE_HELPER_BYTES,
  stageNativeHelper,
  verifyStagedNativeHelper,
} from './native-helper-loader.mjs';

export const MAX_HELPER_BYTES = MAX_NATIVE_HELPER_BYTES;

export const HELPER_CANDIDATES = Object.freeze([
  Object.freeze({ kind: 'packaged', relativePath: 'native/pdfkit-helper/bin/pdfkit-inspect' }),
  Object.freeze({ kind: 'developer-release', relativePath: 'native/pdfkit-helper/.build/release/pdfkit-inspect' }),
]);

export function stagePdfKitHelper(options = {}) {
  return stageNativeHelper({
    ...options,
    candidates: HELPER_CANDIDATES,
    destinationName: 'pdfkit-inspect',
    label: 'PDFKit helper',
  });
}

export function verifyStagedPdfKitHelper(options = {}) {
  return verifyStagedNativeHelper({ ...options, label: 'PDFKit helper' });
}
