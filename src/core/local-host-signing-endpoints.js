import { normalizeCertificateSignatureRequest } from './pdf-certificate-signature-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const SHA256 = /^[0-9a-f]{64}$/u;
export function createSigningEndpoints({ json }) {
  return Object.freeze({
    listSigningIdentities(options = {}) {
      if (!exactObject(options, options?.signal === undefined ? [] : ['signal']) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Signing identity options are invalid.');
      return json('/api/signing-identities', { method: 'GET', signal: options.signal });
    },
    signCertificate(documentId, request, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Certificate signature options are invalid.');
      const fixed = normalizeCertificateSignatureRequest(request);
      return json(`/api/documents/${encodeURIComponent(documentId)}/certificate-sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixed), signal: options.signal }).then((body) => body?.result);
    },
  });
}
