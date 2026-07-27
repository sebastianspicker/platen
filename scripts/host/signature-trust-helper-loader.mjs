import {
  MAX_NATIVE_HELPER_BYTES,
  stageNativeHelper,
  verifyStagedNativeHelper,
} from './native-helper-loader.mjs';

export const MAX_SIGNATURE_TRUST_HELPER_BYTES = MAX_NATIVE_HELPER_BYTES;

export const SIGNATURE_TRUST_HELPER_CANDIDATES = Object.freeze([
  Object.freeze({ kind: 'packaged', relativePath: 'native/pdfkit-helper/bin/pdf-signature-trust' }),
  Object.freeze({ kind: 'developer-release', relativePath: 'native/pdfkit-helper/.build/release/pdf-signature-trust' }),
]);

export function stageSignatureTrustHelper(options = {}) {
  return stageNativeHelper({
    ...options,
    candidates: SIGNATURE_TRUST_HELPER_CANDIDATES,
    destinationName: 'pdf-signature-trust',
    label: 'signature trust helper',
  });
}

export function verifyStagedSignatureTrustHelper(options = {}) {
  return verifyStagedNativeHelper({ ...options, label: 'signature trust helper' });
}
