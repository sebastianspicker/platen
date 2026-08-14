import { HostError } from '../host-error.mjs';
import { INCREMENTAL_NAMED_DESTINATION_PROFILE, normalizeIncrementalNamedDestination } from '../pdf-incremental-named-destination-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function handleIncrementalNamedDestinationRoute(context) {
  if (context.operation !== 'incremental-named-destination') return false;
  const { request, response, url, documentId, processing, store, incrementalNamedDestination, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Incremental named-destination editing does not accept query parameters.', 400);
  if (!incrementalNamedDestination) throw new HostError('INCREMENTAL_NAMED_DESTINATION_UNAVAILABLE', 'The local incremental named-destination service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'targetPage', 'name']) || body.profile !== INCREMENTAL_NAMED_DESTINATION_PROFILE || !SHA256.test(body.sourceSha256) || !NAME.test(body.name)) {
    throw new HostError('INVALID_INCREMENTAL_NAMED_DESTINATION_OPTIONS', 'Incremental named destinations require the fixed profile, lowercase source SHA-256, target page, and bounded ASCII name.', 400);
  }
  let value;
  try { value = normalizeIncrementalNamedDestination({ profile: body.profile, targetPage: body.targetPage, name: body.name }); } catch {
    throw new HostError('INVALID_INCREMENTAL_NAMED_DESTINATION_OPTIONS', 'Incremental named destinations require a valid target page and bounded ASCII name.', 400);
  }
  const result = await incrementalNamedDestination.update(documentId, value, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
