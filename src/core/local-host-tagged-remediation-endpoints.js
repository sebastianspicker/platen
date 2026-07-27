import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const SHA256 = /^[a-f0-9]{64}$/u;
export function createTaggedRemediationEndpoints({ json }) {
  return Object.freeze({
    updateTaggedRemediation(documentId, request, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
        || !request || request.profile !== 'local-tagged-pdf-remediation-v1'
        || !SHA256.test(request.sourceSha256 ?? '') || !request.plan
        || typeof request.plan !== 'object' || Array.isArray(request.plan)
        || !request.roleMap || typeof request.roleMap !== 'object'
        || Array.isArray(request.roleMap)
        || !(request.language === null || typeof request.language === 'string')
        || !(request.title === null || typeof request.title === 'string')) {
        throw new TypeError('Tagged remediation options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/tagged-remediation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal: options.signal,
      }).then((body) => body?.result);
    },
  });
}
