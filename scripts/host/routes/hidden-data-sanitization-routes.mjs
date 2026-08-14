import { HostError } from '../host-error.mjs';
import { PDF_HIDDEN_DATA_SANITIZER_PROFILE } from '../pdf-hidden-data-sanitizer.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handleHiddenDataSanitizationRoute({ request, response, url, documentId, operation, processing, store, hiddenDataSanitization, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'sanitize-hidden-data') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Hidden-data sanitization does not accept query parameters.', 400);
  if (!hiddenDataSanitization) throw new HostError('HIDDEN_DATA_SANITIZATION_UNAVAILABLE', 'The hidden-data sanitizer is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256']) || body.profile !== PDF_HIDDEN_DATA_SANITIZER_PROFILE || !/^[0-9a-f]{64}$/u.test(body.sourceSha256)) throw new HostError('INVALID_HIDDEN_DATA_SANITIZATION_OPTIONS', 'Hidden-data sanitization requires the fixed profile and current lowercase source SHA-256.', 400);
  const result = await hiddenDataSanitization.sanitize(documentId, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result }); return true;
}
