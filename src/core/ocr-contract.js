import {
  CLEANUP_PRESETS,
  OCR_LIMITS,
  SEGMENTATION_MODES,
  ZONE_TYPES,
} from './ocr-contract-shared.js';

export const OCR_CLEANUP_PRESETS = Object.freeze([...CLEANUP_PRESETS]);
export const OCR_SEGMENTATION_MODES = Object.freeze([...SEGMENTATION_MODES]);
export const OCR_ZONE_TYPES = Object.freeze([...ZONE_TYPES]);
export { OCR_LIMITS };

export {
  normalizeOcrBatchRequest,
  normalizeOcrDocumentRequest,
  normalizeOcrLayoutRequest,
  normalizeOcrUserDictionary,
  validateInstalledOcrLanguage,
} from './ocr-request-contract.js';

export {
  validateOcrBatchManifest,
  validateOcrDocumentResult,
  validateOcrLayoutResult,
} from './ocr-result-contract.js';
