import {
  stageNativeHelper,
  verifyStagedNativeHelper,
} from './native-helper-loader.mjs';

export const SCANNER_DISCOVERY_HELPER_CANDIDATES = Object.freeze([
  Object.freeze({ kind: 'packaged', relativePath: 'native/pdfkit-helper/bin/pdf-scanner-acquisition' }),
  Object.freeze({ kind: 'developer-release', relativePath: 'native/pdfkit-helper/.build/release/pdf-scanner-acquisition' }),
  Object.freeze({ kind: 'developer-debug', relativePath: 'native/pdfkit-helper/.build/arm64-apple-macosx/debug/pdf-scanner-acquisition' }),
]);

export function stageScannerDiscoveryHelper(options = {}) {
  return stageNativeHelper({
    ...options,
    candidates: SCANNER_DISCOVERY_HELPER_CANDIDATES,
    destinationName: 'pdf-scanner-acquisition',
    label: 'scanner discovery helper',
  });
}

export function verifyStagedScannerDiscoveryHelper(options = {}) {
  return verifyStagedNativeHelper({ ...options, label: 'scanner discovery helper' });
}
