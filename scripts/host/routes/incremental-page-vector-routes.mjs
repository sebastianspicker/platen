import { HostError } from '../host-error.mjs';
import { INCREMENTAL_PAGE_VECTOR_PROFILE } from '../pdf-page-vector-contract.mjs';
import { normalizeIncrementalPageVector } from '../pdf-page-vector-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export async function handleIncrementalPageVectorRoute(context) {
  if (context.operation !== 'incremental-page-vector') return false;
  const { request, response, url, documentId, processing, incrementalPageVector, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Incremental page-vector editing does not accept query parameters.', 400);
  }
  if (!incrementalPageVector) {
    throw new HostError('INCREMENTAL_PAGE_VECTOR_UNAVAILABLE', 'The local incremental page-vector service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'page', 'rect'])
    || body.profile !== INCREMENTAL_PAGE_VECTOR_PROFILE || !SHA256.test(body.sourceSha256)) {
    throw new HostError('INVALID_INCREMENTAL_PAGE_VECTOR_OPTIONS', 'Incremental page-vector editing requires the fixed profile, current lowercase source SHA-256, page, and rectangle.', 400);
  }
  let value;
  try {
    value = normalizeIncrementalPageVector({
      profile: body.profile,
      page: body.page,
      rect: body.rect,
    });
  } catch {
    throw new HostError('INVALID_INCREMENTAL_PAGE_VECTOR_OPTIONS', 'Incremental page-vector editing requires a valid page and rectangle.', 400);
  }
  const result = await incrementalPageVector.update(documentId, value, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
