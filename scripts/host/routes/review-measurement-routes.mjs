import { HostError } from '../host-error.mjs';
import { PDF_REVIEW_MEASUREMENT_PROFILE, normalizePdfReviewMeasurement } from '../pdf-review-measurement-contract.mjs';
import { validateReviewMeasurementResult } from '../../../src/core/local-host-review-measurement-endpoints.js';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;

async function revokeTrustedCandidate(store, result, documentId, sourceSha256) {
  if (typeof result?.artifact?.id !== 'string' || typeof store?.getArtifact !== 'function'
    || typeof store.deleteArtifact !== 'function') return;
  let retained;
  try { retained = await store.getArtifact(result.artifact.id); } catch { return; }
  const sourceInput = retained?.operation?.inputs?.find((input) => input?.role === 'source');
  if (retained?.id !== result.artifact.id || retained.documentId !== documentId
    || retained.operation?.type !== 'pdf-review-measurement'
    || sourceInput?.documentId !== documentId || sourceInput?.sha256 !== sourceSha256) return;
  await store.deleteArtifact(retained.id).catch(() => {});
}

export async function handleReviewMeasurementRoute(context) {
  if (context.operation !== 'review-measurement') return false;
  const {
    request, response, url, documentId, processing, store,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  const reviewMeasurement = context.reviewMeasurements ?? context.reviewMeasurement;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Review measurement does not accept query parameters.', 400);
  if (!reviewMeasurement || typeof reviewMeasurement.create !== 'function') throw new HostError('REVIEW_MEASUREMENT_UNAVAILABLE', 'Local review measurement is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'expectedRevision', 'id', 'page', 'kind', 'points', 'calibration', 'label', 'displayUnit'])
    || body.profile !== PDF_REVIEW_MEASUREMENT_PROFILE || !SHA256.test(body.sourceSha256 ?? '')) {
    throw new HostError('INVALID_REVIEW_MEASUREMENT_OPTIONS', 'Review measurement requires the fixed profile, current lowercase source SHA-256, and exact measurement body.', 400);
  }
  let normalized;
  try { normalized = normalizePdfReviewMeasurement(body); } catch { throw new HostError('INVALID_REVIEW_MEASUREMENT_OPTIONS', 'Review measurement options are invalid.', 400); }
  const document = store.getDocument(documentId);
  if (document.sha256 !== normalized.sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'Review measurement source digest does not match the current document.', 409);
  let result;
  try {
    result = await reviewMeasurement.create(documentId, normalized, { sourceSha256: normalized.sourceSha256, signal: processing.signal });
    try { validateReviewMeasurementResult(result, { documentId, request: normalized }); } catch { throw new HostError('PDF_REVIEW_MEASUREMENT_OUTPUT_INVALID', 'Review measurement returned an invalid source-bound artifact receipt.', 502); }
  } catch (error) {
    await revokeTrustedCandidate(store, result, documentId, normalized.sourceSha256);
    throw error;
  }
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
