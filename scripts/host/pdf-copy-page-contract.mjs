import { HostError } from './host-error.mjs';

export const PDF_COPY_PAGE_PROFILE = 'local-copy-one-page-between-documents-v1';
export const PDF_COPY_PAGE_VALIDATORS = Object.freeze([
  'source-sha256',
  'private-source-copy',
  'bounded-passive-graph-scan',
  'poppler-page-boxes-text-render-manifest',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const FIELDS = Object.freeze(['profile', 'primarySourceSha256', 'secondarySourceSha256', 'sourcePage', 'afterPage']);

function fail(message) { throw new HostError('INVALID_COPY_PAGE_REQUEST', message, 400); }

export function validateCopyPageRequest(request, primary, secondary) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype
    || JSON.stringify(Object.keys(request)) !== JSON.stringify(FIELDS)) fail('The copy-page request must contain exactly the fixed fields in order.');
  if (request.profile !== PDF_COPY_PAGE_PROFILE) fail('The copy-page profile is unsupported.');
  if (!SHA256.test(request.primarySourceSha256) || !SHA256.test(request.secondarySourceSha256)
    || request.primarySourceSha256 !== primary.sha256 || request.secondarySourceSha256 !== secondary.sha256) {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'The copy-page source digest does not match the current document.', 409);
  }
  if (!Number.isSafeInteger(request.sourcePage) || request.sourcePage < 1 || request.sourcePage > secondary.pageCount) fail(`sourcePage must be from 1 through ${secondary.pageCount}.`);
  if (!Number.isSafeInteger(request.afterPage) || request.afterPage < 0 || request.afterPage > primary.pageCount) fail(`afterPage must be from 0 through ${primary.pageCount}.`);
  return Object.freeze({ ...request });
}
