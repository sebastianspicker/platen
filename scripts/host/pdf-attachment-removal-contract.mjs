export const PDF_ATTACHMENT_REMOVAL_PROFILE = 'local-document-attachment-removal-v1';

function invalid() {
  const error = new Error('PDF attachment-removal request is invalid.');
  error.code = 'INVALID_PDF_ATTACHMENT_REMOVAL';
  return error;
}

export function pdfAttachmentRemovalOutputFailure() {
  const error = new Error('PDF attachment-removal output is invalid.');
  error.code = 'INVALID_PDF_ATTACHMENT_REMOVAL_OUTPUT';
  return error;
}

export function normalizePdfAttachmentRemoval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(descriptors, 'profile')
    || !Object.hasOwn(descriptors.profile, 'value') || !descriptors.profile.enumerable
    || descriptors.profile.value !== PDF_ATTACHMENT_REMOVAL_PROFILE) throw invalid();
  return Object.freeze({ profile: PDF_ATTACHMENT_REMOVAL_PROFILE });
}

export function pdfAttachmentRemovalFailure() { return invalid(); }
