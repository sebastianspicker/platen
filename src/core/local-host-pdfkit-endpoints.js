import { PlatenError } from './errors.js';
import {
  exactObject, OPAQUE_ID_PATTERN,
  PDFKIT_INK_ANNOTATION_PROFILE, PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE, PDFKIT_METADATA_SANITIZATION_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_MUTATION_PROFILE, PDFKIT_PROTECTION_PROFILE,
  PDFKIT_PROTECTION_REMOVAL_PROFILE, PDFKIT_TARGETED_PROFILE,
  validPdfKitInkAnnotationMutation, validPdfKitLineAnnotationMutation,
  validPdfKitLocalGoToMutation, validPdfKitMutation, validPdfKitProtection,
  validPdfKitLocalGoToRemovalMutation,
  validPdfKitOutlineMutation,
  validPdfKitOutlineRemovalMutation,
  validPdfKitOutlineRenameMutation,
  validPdfKitProtectionRemoval, validPdfKitTargetedMutation,
  validatePdfKitMutationResult,
  validatePdfKitMetadataSanitizationResult, validatePdfKitProtectionRemovalResult,
} from './pdfkit-client-contract.js';
import {
  normalizePdfKitTextFieldWidgetRequest,
  PDFKIT_TEXT_FIELD_WIDGET_PROFILE,
  validatePdfKitTextFieldWidgetResult,
} from './pdfkit-client-text-field-widget-contract.js';

const validOptions = (options) => exactObject(options, ['signal']) || exactObject(options, []);
const validSignal = (options) => options.signal === undefined || options.signal instanceof AbortSignal;
const validDigest = (value) => /^[0-9a-f]{64}$/.test(value ?? '');
const mutation = (json, documentId, sourceSha256, value, options, profile, predicate, message) => {
  if (!validDigest(sourceSha256) || !predicate(value) || !validOptions(options) || !validSignal(options)) throw new TypeError(message);
  return json(`/api/documents/${encodeURIComponent(documentId)}/pdfkit-mutation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, sourceSha256, mutation: value }), signal: options.signal,
  }).then((body) => {
    if (!exactObject(body, ['result'])) {
      throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid PDFKit mutation response.');
    }
    return validatePdfKitMutationResult(body.result, {
      documentId, sourceSha256, mutation: value, profile,
    });
  });
};

/** Endpoint family; the facade owns authentication and supplies transport. */
export function createPdfKitEndpoints({ json }) {
  return {
    runPdfKitInspection(documentId, options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'signal')) throw new TypeError('PDFKit inspection options are invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/pdfkit-inspection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: 'macos-read-only-v1' }), signal: options.signal }).then((body) => body.inspection);
    },
    runPdfKitMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_MUTATION_PROFILE, validPdfKitMutation, 'PDFKit mutation options are invalid.'); },
    runPdfKitTargetedMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_TARGETED_PROFILE, validPdfKitTargetedMutation, 'Targeted PDFKit mutation options are invalid.'); },
    runPdfKitLocalGoToMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_LOCAL_GOTO_PROFILE, validPdfKitLocalGoToMutation, 'Local GoTo PDFKit mutation options are invalid.'); },
    runPdfKitLocalGoToRemovalMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE, validPdfKitLocalGoToRemovalMutation, 'Local GoTo removal options are invalid.'); },
    runPdfKitOutlineMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_OUTLINE_PROFILE, validPdfKitOutlineMutation, 'Outline bookmark PDFKit mutation options are invalid.'); },
    runPdfKitOutlineRemovalMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_OUTLINE_REMOVAL_PROFILE, validPdfKitOutlineRemovalMutation, 'Outline bookmark removal options are invalid.'); },
    runPdfKitOutlineRenameMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_OUTLINE_RENAME_PROFILE, validPdfKitOutlineRenameMutation, 'Outline bookmark rename options are invalid.'); },
    runPdfKitLineAnnotationMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_LINE_ANNOTATION_PROFILE, validPdfKitLineAnnotationMutation, 'Line annotation PDFKit mutation options are invalid.'); },
    runPdfKitInkAnnotationMutation(documentId, sourceSha256, value, options = {}) { return mutation(json, documentId, sourceSha256, value, options, PDFKIT_INK_ANNOTATION_PROFILE, validPdfKitInkAnnotationMutation, 'Ink annotation PDFKit mutation options are invalid.'); },
    addPdfKitTextFieldWidget(documentId, sourceSha256, value, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validDigest(sourceSha256) || !exactObject(options, options.signal === undefined ? [] : ['signal']) || !validSignal(options)) throw new TypeError('PDFKit text-field widget options are invalid.');
      const request = normalizePdfKitTextFieldWidgetRequest(value);
      return json(`/api/documents/${encodeURIComponent(documentId)}/pdfkit-text-field-widget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: PDFKIT_TEXT_FIELD_WIDGET_PROFILE, sourceSha256, ...request }), signal: options.signal }).then((body) => {
        if (!exactObject(body, ['result'])) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid PDFKit text-field widget response.');
        return validatePdfKitTextFieldWidgetResult(body.result, {
          documentId, sourceSha256, request,
        });
      });
    },
    protectPdfKit(documentId, sourceSha256, protection, options = {}) {
      if (!validDigest(sourceSha256) || !validPdfKitProtection(protection) || !validOptions(options) || !validSignal(options)) throw new TypeError('PDFKit protection options are invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/pdfkit-protection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: PDFKIT_PROTECTION_PROFILE, sourceSha256, protection }), signal: options.signal }).then((body) => body.result);
    },
    removePdfKitProtection(documentId, sourceSha256, removal, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validDigest(sourceSha256) || !validPdfKitProtectionRemoval(removal) || !validOptions(options) || !validSignal(options)) throw new TypeError('PDFKit protection-removal options are invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/pdfkit-protection-removal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: PDFKIT_PROTECTION_REMOVAL_PROFILE, sourceSha256, removal }), signal: options.signal }).then((body) => validatePdfKitProtectionRemovalResult(body.result, { documentId, sourceSha256, removal }));
    },
    sanitizePdfKitMetadata(documentId, sourceSha256, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validDigest(sourceSha256) || !exactObject(options, options.signal === undefined ? [] : ['signal']) || !validSignal(options)) throw new TypeError('PDFKit metadata-sanitization options are invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/sanitization`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: PDFKIT_METADATA_SANITIZATION_PROFILE, sourceSha256 }), signal: options.signal }).then((body) => {
        if (!exactObject(body, ['result'])) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid PDFKit metadata-sanitization response.');
        return validatePdfKitMetadataSanitizationResult(body.result, { documentId, sourceSha256 });
      });
    },
  };
}
