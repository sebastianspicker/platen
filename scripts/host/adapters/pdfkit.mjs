export { PDFKitAdapter } from './pdfkit/execution-adapter.mjs';
export { parsePdfkitResponse } from './pdfkit/inspection-response.mjs';
export {
  parsePdfkitInkAnnotationResponse,
  parsePdfkitLineAnnotationResponse,
  parsePdfkitLocalGoToResponse,
  parsePdfkitLocalGoToRemovalResponse,
  parsePdfkitMutationResponse,
  parsePdfkitOutlineBookmarkResponse,
  parsePdfkitOutlineBookmarkRemovalResponse,
  parsePdfkitOutlineBookmarkRenameResponse,
} from './pdfkit/mutation-response.mjs';
export {
  parsePdfkitProtectionRemovalResponse,
  parsePdfkitProtectionResponse,
} from './pdfkit/protection-response.mjs';
export { parsePdfkitMetadataSanitizationResponse } from './pdfkit/sanitization-response.mjs';
export { parsePdfkitAecMeasurementResponse } from './pdfkit/aec-response.mjs';
export {
  DEFAULT_TEXT_FIELD_WIDGET_LIMITS,
  PDFKIT_TEXT_FIELD_WIDGET_OPERATION,
  PDFKIT_TEXT_FIELD_WIDGET_PROFILE,
  buildTextFieldWidgetRequest,
  normalizeTextFieldWidgetRequest,
  parsePdfkitTextFieldWidgetResponse,
  receiptMatchesTextFieldWidgetContract,
  serializeTextFieldWidgetRequest,
} from '../pdfkit-text-field-widget-contract.mjs';
export { PDFKIT_MAX_RESPONSE_BYTES } from './pdfkit/response-common.mjs';
export {
  createPdfkitRequestPath,
  PDFKIT_MAX_REQUEST_BYTES,
  PDFKIT_REQUEST_FILENAME,
} from './pdfkit/workspace.mjs';

export const PDFKIT_INSPECT_OPERATION = 'inspect';
export const PDFKIT_MUTATE_OPERATION = 'mutate';
export const PDFKIT_ADD_TEXT_FIELD_WIDGET_OPERATION = 'addTextFieldWidget';
