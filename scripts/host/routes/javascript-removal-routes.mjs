import { HostError } from '../host-error.mjs';
import { PDF_JAVASCRIPT_REMOVAL_PROFILE } from '../pdf-javascript-removal-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

function isLowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export async function handleJavaScriptRemovalRoute(context) {
  if (context.operation !== 'javascript-removal') return false;
  const {
    request, response, url, documentId, processing, store, javascriptRemoval,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'JavaScript removal does not accept query parameters.', 400);
  }
  if (!javascriptRemoval) {
    throw new HostError('JAVASCRIPT_REMOVAL_UNAVAILABLE', 'The local JavaScript-removal service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256'])
    || body.profile !== PDF_JAVASCRIPT_REMOVAL_PROFILE || !isLowercaseSha256(body.sourceSha256)) {
    throw new HostError('INVALID_JAVASCRIPT_REMOVAL_OPTIONS', 'JavaScript removal requires the fixed profile and current lowercase source SHA-256.', 400);
  }
  const result = await javascriptRemoval.remove(documentId, { profile: body.profile }, {
    sourceSha256: body.sourceSha256, signal: processing.signal,
  });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
