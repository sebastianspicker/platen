import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_PAGE_HEADER_FOOTER_PROFILE = 'local-pdf-page-header-footer-v1';
export const PDF_PAGE_HEADER_FOOTER_LIMITATIONS = Object.freeze([
  'Only fixed black monospaced Courier headers and automatic page-number footers are added to selected unrotated pages in a bounded passive classic PDF subset.',
  'This operation does not support forms, actions, tags, layers, signatures, encryption, templates, images, transparency, rotated pages, or complex PDF structures.',
  'The source revision remains the historical prefix; the result is a separately retained append-only artifact.',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const EVIDENCE = Object.freeze(['sourceDigestReverified', 'sourcePrefixPreserved', 'headerFooterEffectProven', 'onlySelectedPagesChanged', 'pageBoxesPreserved', 'resourcesPreserved', 'annotationsPreserved', 'artifactDigestBound', 'sourceUnchanged', 'localOnly']);
function validRequest(value) { return exactObject(value, ['profile', 'sourceSha256', 'pages', 'header', 'footerPrefix']) && value.profile === PDF_PAGE_HEADER_FOOTER_PROFILE && SHA256.test(value.sourceSha256 ?? '') && Array.isArray(value.pages) && value.pages.length >= 1 && value.pages.length <= 500 && value.pages.every((page, index) => Number.isSafeInteger(page) && page >= 1 && page <= 500 && (index === 0 || page > value.pages[index - 1])) && ['header', 'footerPrefix'].every((key) => typeof value[key] === 'string' && value[key].length >= 1 && value[key] === value[key].normalize('NFC') && /^[\x20-\x7e]+$/u.test(value[key]) && new TextEncoder().encode(value[key]).byteLength <= 256); }
function artifact(value, context) { return exactObject(value, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'createdAt']) && OPAQUE_ID_PATTERN.test(value.id ?? '') && value.id !== context.documentId && value.documentId === context.documentId && value.displayName === 'page-header-footer.pdf' && value.mediaType === 'application/pdf' && Number.isSafeInteger(value.size) && value.size >= 64 && value.size <= 33 * 1024 * 1024 && SHA256.test(value.sha256 ?? '') && value.sha256 !== context.sourceSha256 && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt)); }
function invalid() { throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound page header/footer result.'); }
export function validatePdfPageHeaderFooterResult(value, context) {
  if (!validRequest(context?.request) || !SHA256.test(context?.sourceSha256 ?? '') || !SHA256.test(context?.headerSha256 ?? '') || !SHA256.test(context?.footerPrefixSha256 ?? '')
    || !exactObject(value, ['kind', 'artifact', 'pages', 'evidence', 'limitations']) || value.kind !== 'pdf-page-header-footer' || !artifact(value.artifact, context)
    || !Array.isArray(value.pages) || value.pages.length !== context.request.pages.length || !value.pages.every((item, index) => exactObject(item, ['page', 'applied']) && item.page === context.request.pages[index] && item.applied === true)
    || !exactObject(value.evidence, EVIDENCE) || EVIDENCE.some((key) => value.evidence[key] !== true) || !Array.isArray(value.limitations) || value.limitations.length !== PDF_PAGE_HEADER_FOOTER_LIMITATIONS.length || value.limitations.some((item, index) => item !== PDF_PAGE_HEADER_FOOTER_LIMITATIONS[index])) invalid();
  return Object.freeze(value);
}
