// Compatibility facade for bounded, fail-closed local PDF evidence parsers.
export {
  normalizeKey,
  parseCustomMetadata,
  parsePageBoxes,
  parsePageDimensions,
  parsePdfInfo,
  parseTaggedStructure,
  parseTextPages,
  parseXmpMetadata,
} from './pdf-evidence-metadata-parsers.mjs';
export { parseDocumentUrls, parseNamedDestinations } from './pdf-evidence-navigation-parsers.mjs';
export { dataLines, parseAttachments, parseFonts, parseImages } from './pdf-evidence-resource-parsers.mjs';
export {
  acceptedPdfsigStderr,
  executeOfflineSignatureInspection,
  parseSignatures,
  signatureOutputError,
} from './pdf-evidence-signature-parsers.mjs';
