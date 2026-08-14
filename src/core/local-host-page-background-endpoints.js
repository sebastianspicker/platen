import { PDF_PAGE_BACKGROUND_PROFILE, validPageBackgroundRequest, validatePageBackgroundResult } from './pdf-page-background-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const SHA256 = /^[0-9a-f]{64}$/u;
export function createPageBackgroundEndpoints({ json }) { return Object.freeze({ createPageBackground(documentId, sourceSha256, request, options = {}) { const optionKeys = options?.signal === undefined ? [] : ['signal'];
if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !validPageBackgroundRequest(request) || !exactObject(options, optionKeys) || (options.signal !== undefined
    && !(options.signal instanceof AbortSignal))) throw new TypeError('Page-background options are invalid.');
const fixedRequest = Object.freeze({ pages: Object.freeze([...request.pages]), color: Object.freeze({ ...request.color }) });
return json(`/api/documents/${encodeURIComponent(documentId)}/page-background`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256, pages: fixedRequest.pages, color: fixedRequest.color }), signal: options.signal }).then((body) => validatePageBackgroundResult(body?.result, { documentId, sourceSha256, request: fixedRequest }));
} });
}
