import { HostError } from '../host-error.mjs';
import {
  REVIEW_SIDECAR_INSPECTION_KIND,
  REVIEW_SIDECAR_STATUS_KIND,
  normalizeReviewSidecarInspectionRequest,
  normalizeReviewSidecarStatusRequest,
  freezeReviewSidecarResult,
} from '../pdf-review-sidecar-contract.mjs';

export async function handleReviewSidecarRoute(context) {
  const { operation } = context;
  if (operation !== 'review-sidecar-status' && operation !== 'review-sidecar-inspect') return false;

  const {
    request, response, url, documentId, processing, reviewSidecar,
    bodyLimit, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Review sidecar routes do not accept query parameters.', 400);
  }

  const isStatus = operation === 'review-sidecar-status';
  const methodName = isStatus ? 'setStatus' : 'inspect';
  if (!reviewSidecar || typeof reviewSidecar[methodName] !== 'function') {
    throw new HostError('REVIEW_SIDECAR_UNAVAILABLE', 'The local review sidecar service is unavailable.', 503);
  }

  const body = await readJson(request, bodyLimit);
  if (isStatus) normalizeReviewSidecarStatusRequest(body);
  else normalizeReviewSidecarInspectionRequest(body);
  let result;
  try {
    result = await reviewSidecar[methodName](documentId, body, { signal: processing.signal });
  } catch (error) {
    throw error;
  }

  let checked;
  try {
    checked = freezeReviewSidecarResult(result);
    if (checked.kind === REVIEW_SIDECAR_STATUS_KIND) {
      if (checked.sourceDigest !== body.sourceSha256 || checked.annotationId !== body.annotationId
        || checked.status !== body.status || checked.customStatus !== body.customStatus
        || checked.revision !== body.expectedRevision + 1) throw new TypeError('Status result is not bound to its request.');
    } else if (checked.kind === REVIEW_SIDECAR_INSPECTION_KIND
      && (checked.sourceDigest !== body.sourceSha256 || checked.revision !== body.expectedRevision)) {
      throw new TypeError('Inspection result is not bound to its request.');
    }
  } catch (error) {
    throw new HostError('REVIEW_SIDECAR_RESULT_INVALID', 'The review sidecar service returned invalid evidence.', 502, { cause: error });
  }
  if (processing.signal.aborted || response.destroyed) return true;
  json(response, 200, { result: structuredClone(checked) });
  return true;
}
