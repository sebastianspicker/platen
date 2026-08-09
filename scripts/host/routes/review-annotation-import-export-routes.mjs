import { HostError } from '../host-error.mjs';
import {
  PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE,
  normalizeReviewAnnotationImportExport,
} from '../pdf-review-annotation-import-export-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;

async function revokeTrustedCandidate(store, result, documentId, sourceSha256) {
  if (typeof result?.artifact?.id !== 'string' || typeof store?.getArtifact !== 'function' || typeof store.deleteArtifact !== 'function') return;
  const retained = await store.getArtifact(result.artifact.id).catch(() => null);
  const source = retained?.operation?.inputs?.find((input) => input?.role === 'source');
  if (retained?.id === result.artifact.id && retained.documentId === documentId
    && retained.operation?.type === 'pdf-review-annotation-import-export'
    && source?.documentId === documentId && source.sha256 === sourceSha256) await store.deleteArtifact(retained.id).catch(() => {});
}

export async function handleReviewAnnotationImportExportRoute(context) {
  if (context.operation !== 'review-annotation-import-export') return false;
  const { request, response, url, documentId, processing, store, reviewAnnotationImportExport, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Review annotation import/export does not accept query parameters.', 400);
  if (!reviewAnnotationImportExport || typeof reviewAnnotationImportExport.importExport !== 'function') throw new HostError('REVIEW_ANNOTATION_IMPORT_EXPORT_UNAVAILABLE', 'The local review annotation import/export service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'expectedRevision', 'xfdf'])
    || body.profile !== PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE || !SHA256.test(body.sourceSha256 ?? '')) throw new HostError('INVALID_REVIEW_ANNOTATION_IMPORT_EXPORT_OPTIONS', 'Review annotation import/export requires the fixed profile, current source SHA-256, revision, and canonical XFDF.', 400);
  let value;
  try { value = normalizeReviewAnnotationImportExport(body); } catch (error) { throw new HostError('INVALID_REVIEW_ANNOTATION_IMPORT_EXPORT_OPTIONS', 'Review annotation import/export options are outside the bounded contract.', 400, { cause: error }); }
  const source = store.getDocument(documentId);
  if (source.sha256 !== value.sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'Review annotation source digest does not match the current document.', 409);
  let result;
  try { result = await reviewAnnotationImportExport.importExport(documentId, value, { sourceSha256: value.sourceSha256, signal: processing.signal }); }
  catch (error) { await revokeTrustedCandidate(store, result, documentId, value.sourceSha256); throw error; }
  if (!result || result.kind !== 'pdf-review-annotation-import-export' || result.sourceDigest !== value.sourceSha256 || result.revision !== value.expectedRevision || result.xfdf !== value.xfdf || result.annotation?.subtype !== 'Text' || result.artifact?.sha256 !== result.annotation?.outputSha256) {
    await revokeTrustedCandidate(store, result, documentId, value.sourceSha256);
    throw new HostError('REVIEW_ANNOTATION_IMPORT_EXPORT_OUTPUT_INVALID', 'The review annotation service returned an invalid retained result.', 502);
  }
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
