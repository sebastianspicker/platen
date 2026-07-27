import {
  MAX_NATIVE_HELPER_BYTES,
  stageNativeHelper,
  verifyStagedNativeHelper,
} from './native-helper-loader.mjs';

export const MAX_SIGNING_IDENTITY_HELPER_BYTES = MAX_NATIVE_HELPER_BYTES;

export const SIGNING_IDENTITY_HELPER_CANDIDATES = Object.freeze([
  Object.freeze({ kind: 'packaged', relativePath: 'native/pdfkit-helper/bin/pdf-signing-identity' }),
  Object.freeze({ kind: 'developer-release', relativePath: 'native/pdfkit-helper/.build/release/pdf-signing-identity' }),
]);

export function stageSigningIdentityHelper(options = {}) {
  return stageNativeHelper({
    ...options,
    candidates: SIGNING_IDENTITY_HELPER_CANDIDATES,
    destinationName: 'pdf-signing-identity',
    label: 'signing identity helper',
  });
}

export function verifyStagedSigningIdentityHelper(options = {}) {
  return verifyStagedNativeHelper({ ...options, label: 'signing identity helper' });
}

