import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkPdfKitMutationLimits,
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  normalizePdfKitMutation,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  serializePdfKitMutationRequest,
  summarizePdfKitMutation,
} from '../../scripts/host/pdfkit-mutation-contract.mjs';

const sourceInspection = Object.freeze({
  pageCount: 2, title: 'Before', author: null, subject: null, keywords: null,
});

const normalize = (profile, input) => normalizePdfKitMutation({
  profile,
  input,
  sourceInspection,
});

export {
  assert,
  checkPdfKitMutationLimits,
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  normalize,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  serializePdfKitMutationRequest,
  summarizePdfKitMutation,
  test,
};

export const fingerprint = 'a'.repeat(64);
export const sourceSha256 = 'b'.repeat(64);
