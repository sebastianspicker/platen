import { HostError } from '../host-error.mjs';
import { PDF_FAST_WEB_VIEW_PROFILE } from '../pdf-fast-web-view-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handleFastWebViewRoute({ request, response, url, documentId, operation, processing, store, fastWebView, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'fast-web-view') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Fast web-view does not accept query parameters.', 400);
  if (!fastWebView) throw new HostError('FAST_WEB_VIEW_UNAVAILABLE', 'The qpdf linearization engine is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256']) || body.profile !== PDF_FAST_WEB_VIEW_PROFILE || !/^[0-9a-f]{64}$/u.test(body.sourceSha256)) {
    throw new HostError('INVALID_FAST_WEB_VIEW_OPTIONS', 'Fast web-view requires the fixed profile and current lowercase source SHA-256.', 400);
  }
  const result = await fastWebView.linearize(documentId, { profile: body.profile }, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}

