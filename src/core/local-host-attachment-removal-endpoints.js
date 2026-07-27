import {
  PDF_ATTACHMENT_REMOVAL_PROFILE,
  validatePdfAttachmentRemovalResult,
} from './pdf-attachment-removal-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createAttachmentRemovalEndpoints({ json }) {
  return Object.freeze({
    runAttachmentRemoval(documentId, sourceSha256, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('PDF attachment-removal options are invalid.');
      }
      const signal = options.signal;
      return json(`/api/documents/${encodeURIComponent(documentId)}/attachment-removal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: PDF_ATTACHMENT_REMOVAL_PROFILE, sourceSha256 }),
        signal,
      }).then((body) => validatePdfAttachmentRemovalResult(body?.result, {
        documentId, sourceSha256,
      }));
    },
  });
}
