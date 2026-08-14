import { HostError } from '../host-error.mjs';
import {
  REDACTION_OVERLAY_LABEL_PROFILE,
  normalizeRedactionOverlayLabelRequest,
  validateRedactionOverlayLabelResult,
} from '../../../src/core/pdf-redaction-overlay-label-contract.js';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handleRedactionOverlayLabelRoute(context) {
  if (context.operation !== 'redaction-overlay-label') return false;
  const {
    request, response, url, documentId, processing, redactionOverlayLabels,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Redaction overlay labels do not accept query parameters.', 400);
  }
  if (!redactionOverlayLabels || typeof redactionOverlayLabels.apply !== 'function') {
    throw new HostError('REDACTION_OVERLAY_LABEL_UNAVAILABLE', 'The local redaction overlay-label service is unavailable.', 503);
  }

  let body;
  try {
    body = await readJson(request, bodyLimit);
  } catch (error) {
    throw new HostError('INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', 'Redaction overlay-label options are outside the bounded canonical contract.', 400, { cause: error });
  }

  let exactRequest = false;
  try {
    exactRequest = exactJsonObject(body, ['profile', 'sourceSha256', 'page', 'label'])
      && body.profile === REDACTION_OVERLAY_LABEL_PROFILE;
  } catch (error) {
    throw new HostError('INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', 'Redaction overlay-label options are outside the bounded canonical contract.', 400, { cause: error });
  }
  if (!exactRequest) {
    throw new HostError('INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', 'Redaction overlay labels require the fixed profile, source digest, page, and label.', 400);
  }

  let normalized;
  try {
    normalized = normalizeRedactionOverlayLabelRequest(body);
  } catch (error) {
    throw new HostError('INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', 'Redaction overlay-label options are outside the bounded canonical contract.', 400, { cause: error });
  }

  let result;
  try {
    result = await redactionOverlayLabels.apply(documentId, normalized, { signal: processing.signal });
    validateRedactionOverlayLabelResult(result, {
      documentId,
      sourceSha256: normalized.sourceSha256,
      request: normalized,
    });
  } catch (error) {
    if (error instanceof HostError || error?.code === 'JOB_CANCELLED' || error?.code === 'ENGINE_CANCELLED') throw error;
    throw new HostError('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'Redaction overlay-label service returned invalid source-bound output.', 502, { cause: error });
  }

  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
