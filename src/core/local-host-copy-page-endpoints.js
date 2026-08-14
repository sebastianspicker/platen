import {
  PDF_COPY_PAGE_PROFILE,
  validatePdfCopyPageArtifact,
} from './pdf-copy-page-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_FIELDS = Object.freeze([
  'primarySourceSha256', 'secondarySourceSha256', 'sourcePage', 'afterPage',
]);

export function createCopyPageEndpoints({ json }) {
  return Object.freeze({
    copyPageBetweenDocuments(primaryDocumentId, secondaryDocumentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(primaryDocumentId ?? '')
        || !OPAQUE_ID_PATTERN.test(secondaryDocumentId ?? '')
        || primaryDocumentId === secondaryDocumentId
        || !exactObject(request, REQUEST_FIELDS)
        || !SHA256.test(request.primarySourceSha256 ?? '')
        || !SHA256.test(request.secondarySourceSha256 ?? '')
        || !Number.isSafeInteger(request.sourcePage)
        || request.sourcePage < 1 || request.sourcePage > 100
        || !Number.isSafeInteger(request.afterPage)
        || request.afterPage < 0 || request.afterPage > 100
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Cross-document page-copy options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(primaryDocumentId)}/copy-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: PDF_COPY_PAGE_PROFILE,
          primarySourceSha256: request.primarySourceSha256,
          secondaryDocumentId,
          secondarySourceSha256: request.secondarySourceSha256,
          sourcePage: request.sourcePage,
          afterPage: request.afterPage,
        }),
        signal: options.signal,
      }).then((body) => {
        if (!exactObject(body, ['artifact'])) {
          return validatePdfCopyPageArtifact(null, {
            primaryDocumentId, secondaryDocumentId, request,
          });
        }
        return validatePdfCopyPageArtifact(body.artifact, {
          primaryDocumentId, secondaryDocumentId, request,
        });
      });
    },
  });
}
