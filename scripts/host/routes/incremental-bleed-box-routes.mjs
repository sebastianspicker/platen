import { HostError } from '../host-error.mjs';
import { PDF_INCREMENTAL_BLEED_BOX_PROFILE } from '../pdf-incremental-bleed-box-artifact.mjs';
import { normalizeIncrementalBleedBox } from '../pdf-incremental-bleed-box-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

function sha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export async function handleIncrementalBleedBoxRoute(context) {
  if (context.operation !== 'incremental-bleed-box') return false;
  const { request, response, url, documentId, processing, incrementalBleedBox, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Incremental BleedBox editing does not accept query parameters.', 400);
  if (!incrementalBleedBox) throw new HostError('INCREMENTAL_BLEED_BOX_UNAVAILABLE', 'The local incremental BleedBox service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'page', 'rect']) || body.profile !== PDF_INCREMENTAL_BLEED_BOX_PROFILE || !sha256(body.sourceSha256)) throw new HostError('INVALID_INCREMENTAL_BLEED_BOX_OPTIONS', 'Incremental BleedBox editing requires the fixed profile, current lowercase source SHA-256, page, and rectangle.', 400);
  let requestValue;
  try { requestValue = normalizeIncrementalBleedBox({ profile: body.profile, page: body.page, rect: body.rect }); } catch { throw new HostError('INVALID_INCREMENTAL_BLEED_BOX_OPTIONS', 'Incremental BleedBox editing requires a valid page and rectangle.', 400); }
  const result = await incrementalBleedBox.update(documentId, requestValue, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
