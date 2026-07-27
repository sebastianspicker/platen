import { HostError } from '../host-error.mjs';
import {
  INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
  normalizeIncrementalAccessibilityMetadata,
} from '../pdf-incremental-accessibility-metadata-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export async function handleIncrementalAccessibilityMetadataRoute(context) {
  if (context.operation !== 'incremental-accessibility-metadata') return false;
  const {
    request, response, url, documentId, processing, store, incrementalAccessibilityMetadata,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Incremental accessibility metadata editing does not accept query parameters.', 400);
  if (!incrementalAccessibilityMetadata) throw new HostError('INCREMENTAL_ACCESSIBILITY_METADATA_UNAVAILABLE', 'The local incremental accessibility metadata service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'metadata'])
    || body.profile !== INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE
    || !SHA256.test(body.sourceSha256) || !exactJsonObject(body.metadata, ['language', 'title'])) {
    throw new HostError('INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OPTIONS', 'Incremental accessibility metadata requires the fixed profile, current lowercase source SHA-256, language, and title.', 400);
  }
  let metadata;
  try { metadata = normalizeIncrementalAccessibilityMetadata(body.metadata); } catch {
    throw new HostError('INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OPTIONS', 'Incremental accessibility metadata requires a valid language and title.', 400);
  }
  const result = await incrementalAccessibilityMetadata.update(documentId, metadata, {
    sourceSha256: body.sourceSha256, signal: processing.signal,
  });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
