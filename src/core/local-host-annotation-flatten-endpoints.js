import {
  ANNOTATION_FLATTEN_PROFILE,
  validAnnotationFlattenTarget,
  validateAnnotationFlattenResult,
} from './pdf-annotation-flatten-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createAnnotationFlattenEndpoints({ json }) {
  return Object.freeze({
    runAnnotationFlatten(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !exactObject(request, ['target']) || !validAnnotationFlattenTarget(request.target)
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Annotation-flatten options are invalid.');
      }
      const fixedTarget = Object.freeze({
        page: request.target.page,
        annotationIndex: request.target.annotationIndex,
        fingerprint: request.target.fingerprint,
        subtype: request.target.subtype,
      });
      const fixedRequest = Object.freeze({ target: fixedTarget });
      return json(`/api/documents/${encodeURIComponent(documentId)}/annotation-flatten`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: ANNOTATION_FLATTEN_PROFILE,
          sourceSha256,
          target: fixedTarget,
        }),
        signal: options.signal,
      }).then((body) => validateAnnotationFlattenResult(body?.result, {
        documentId, sourceSha256, request: fixedRequest,
      }));
    },
  });
}
