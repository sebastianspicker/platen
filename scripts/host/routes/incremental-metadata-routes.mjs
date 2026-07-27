import { HostError } from '../host-error.mjs';
import {
  PDF_INCREMENTAL_METADATA_FIELDS,
  PDF_INCREMENTAL_METADATA_PROFILE,
} from '../pdf-incremental-metadata-artifact.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

function isLowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export async function handleIncrementalMetadataRoute(context) {
  if (context.operation !== 'incremental-metadata') return false;
  const {
    request, response, url, documentId, processing, incrementalMetadata, store,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Incremental metadata editing does not accept query parameters.', 400);
  }
  if (!incrementalMetadata) {
    throw new HostError('INCREMENTAL_METADATA_UNAVAILABLE', 'The local incremental metadata service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  const metadata = body?.metadata;
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'metadata'])
    || body.profile !== PDF_INCREMENTAL_METADATA_PROFILE || !isLowercaseSha256(body.sourceSha256)
    || !exactJsonObject(metadata, PDF_INCREMENTAL_METADATA_FIELDS)
    || PDF_INCREMENTAL_METADATA_FIELDS.some((field) => metadata[field] !== null && typeof metadata[field] !== 'string')) {
    throw new HostError('INVALID_INCREMENTAL_METADATA_OPTIONS', 'Incremental metadata editing requires the fixed profile, current lowercase source SHA-256, and exact standard metadata fields.', 400);
  }
  const result = await incrementalMetadata.update(documentId, metadata, {
    sourceSha256: body.sourceSha256, signal: processing.signal,
  });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
