import { createHash } from 'node:crypto';
import { HostError } from '../host-error.mjs';
import { requireBytes, result, fail, sha256 } from './support.mjs';
import { PDF_PAGE_HEADER_FOOTER_PROFILE, validatePdfPageHeaderFooterResult } from '../../../src/core/pdf-page-header-footer-contract.js';
import { normalizePdfPageHeaderFooter } from '../pdf-page-header-footer-contract.mjs';
import { inspectPdfPageHeaderFooter } from '../pdf-page-header-footer-writer.mjs';

const FAMILY = 'content-editing';
const SHA256 = /^[0-9a-f]{64}$/u;
function abort(signal) { if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Page header/footer editing was cancelled.', 499, { cause: signal.reason }); }
function own(ctx, key, required = true) { if (!ctx || Object.getPrototypeOf(ctx) !== Object.prototype || Object.getOwnPropertySymbols(ctx).length !== 0) fail('PDF_PAGE_HEADER_FOOTER_OPTIONS_INVALID', 'Header/footer context must be a plain data object.', 400); const descriptor = Object.getOwnPropertyDescriptor(ctx, key); if (!descriptor) { if (!required) return undefined; fail('PDF_PAGE_HEADER_FOOTER_OPTIONS_INVALID', `Header/footer ${key} must be direct data.`, 400); } if (!Object.hasOwn(descriptor, 'value')) fail('PDF_PAGE_HEADER_FOOTER_OPTIONS_INVALID', `Header/footer ${key} must be direct data.`, 400); return descriptor.value; }
function request(ctx) {
  const source = requireBytes(own(ctx, 'sourcePdf', false) ?? own(ctx, 'sourceBytes'), 'sourcePdf', { max: 32 * 1024 * 1024 }); const sourceSha256 = sha256(source); const supplied = own(ctx, 'sourceSha256');
  if (!SHA256.test(supplied ?? '') || supplied !== sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'The supplied header/footer source digest does not match the supplied source bytes.', 409);
  const value = { profile: PDF_PAGE_HEADER_FOOTER_PROFILE, sourceSha256, pages: own(ctx, 'pages'), header: own(ctx, 'header'), footerPrefix: own(ctx, 'footerPrefix') };
  try { const normalized = normalizePdfPageHeaderFooter(value); return Object.freeze({ source, sourceSha256, request: normalized, headerSha256: createHash('sha256').update(normalized.header, 'utf8').digest('hex'), footerPrefixSha256: createHash('sha256').update(normalized.footerPrefix, 'utf8').digest('hex') }); } catch (error) { fail('PDF_PAGE_HEADER_FOOTER_OPTIONS_INVALID', 'Header/footer request cannot be transport-normalized.', 400, error); }
}
function serviceBoundary(ctx, boundary) {
  const documentId = own(ctx, 'documentId');
  if (typeof documentId !== 'string' || documentId.length === 0) fail('PDF_PAGE_HEADER_FOOTER_DOCUMENT_REQUIRED', 'Page header/footer editing requires an explicit document identity.', 400);
  const service = own(ctx, 'pageHeaderFooter', false);
  if (!service || (typeof service.create !== 'function' && typeof service.apply !== 'function')) fail('PDF_PAGE_HEADER_FOOTER_SERVICE_UNAVAILABLE', 'Production page header/footer service is unavailable.', 503);
  const suppliedReadArtifact = own(ctx, 'readArtifact', false);
  const readArtifact = typeof suppliedReadArtifact === 'function' ? suppliedReadArtifact : typeof service.readArtifact === 'function' ? service.readArtifact.bind(service) : null;
  if (!readArtifact) fail('PDF_PAGE_HEADER_FOOTER_ARTIFACT_READBACK_REQUIRED', 'Page header/footer editing requires retained artifact reread authority.', 503);
  const signal = own(ctx, 'signal', false);
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('PDF_PAGE_HEADER_FOOTER_OPTIONS_INVALID', 'Header/footer signal must be an AbortSignal.', 400);
  return Object.freeze({ ...boundary, documentId, service, readArtifact, signal, store: own(ctx, 'store', false) });
}
async function revoke(boundary, artifact, failure) { if (!artifact || typeof boundary.store?.deleteArtifact !== 'function') throw failure; try { await boundary.store.deleteArtifact(artifact.id); } catch (cleanup) { throw new HostError('EDIT_HEADERS_FOOTERS_CLEANUP_FAILED', 'Failed header/footer editing artifact could not be revoked.', 500, { cause: new AggregateError([failure, cleanup], 'Header/footer cleanup failed.') }); } throw failure; }
export async function editHeadersFooters(ctx = {}) {
  const boundary = serviceBoundary(ctx, request(ctx)); let artifact;
  try { abort(boundary.signal); const invoke = boundary.service.create ?? boundary.service.apply; const receipt = await invoke.call(boundary.service, boundary.documentId, boundary.request, { sourceSha256: boundary.sourceSha256, signal: boundary.signal }); abort(boundary.signal);
    const transport = JSON.parse(JSON.stringify(receipt)); const validated = validatePdfPageHeaderFooterResult(transport, { documentId: boundary.documentId, sourceSha256: boundary.sourceSha256, request: boundary.request, headerSha256: boundary.headerSha256, footerPrefixSha256: boundary.footerPrefixSha256 }); artifact = validated.artifact;
    let bytes; try { bytes = requireBytes(await boundary.readArtifact(artifact), 'pageHeaderFooterArtifact', { max: 33 * 1024 * 1024 }); if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Retained header/footer artifact does not match its receipt.', 502); const proof = inspectPdfPageHeaderFooter(boundary.source, bytes, boundary.request); if (proof.profile !== PDF_PAGE_HEADER_FOOTER_PROFILE || proof.outputSha256 !== artifact.sha256 || proof.sourcePrefixPreserved !== true || proof.pageCount < 1 || JSON.stringify(proof.pages.map(({ page, applied }) => ({ page, applied }))) !== JSON.stringify(validated.pages)) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Independent retained header/footer inspection did not match the receipt.', 502); } finally { bytes?.fill(0); }
    return result('edit.headers-footers', { familyId: FAMILY, method: 'production-pdf-page-header-footer-service', artifact: validated.artifact, serviceReceipt: validated, outputSha256: validated.artifact.sha256, pages: validated.pages, evidence: validated.evidence, limitations: validated.limitations, applied: true, retainedBoundaryValidated: true, productionMode: true, localOnly: true, trustBoundary: Object.freeze({ productionService: true, immutableSourceDigest: true, artifactReread: true, independentSemanticInspection: true }) });
  } catch (error) { await revoke(boundary, artifact, error); }
}
