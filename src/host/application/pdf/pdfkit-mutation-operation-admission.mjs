import {
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
} from './pdfkit-mutation-contract.mjs';
import { MAX_PDFKIT_SOURCE_BYTES } from './pdfkit-mutation-validation.mjs';
import { fail } from './pdfkit-mutation-operation-errors.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const PROFILES = new Set([
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
]);

export function validatePdfKitMutationAdmission({
  store,
  documentId,
  sourceSha256,
  profile = PDFKIT_DERIVED_PROFILE,
}) {
  const source = store.getDocument(documentId);
  if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
    fail(
      'SOURCE_VERSION_MISMATCH',
      'The mutation source digest does not match the current document.',
      409,
    );
  }
  if (!PROFILES.has(profile)) {
    fail('INVALID_PDFKIT_MUTATION', 'The PDFKit mutation profile is unsupported.');
  }
  if (source.size > MAX_PDFKIT_SOURCE_BYTES) {
    fail(
      'PDFKIT_INPUT_TOO_LARGE',
      'PDFKit mutation is limited to 128 MiB source documents.',
      413,
    );
  }
  return Object.freeze({ source, profile });
}
