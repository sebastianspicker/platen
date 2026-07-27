import { HostError } from '../host-error.mjs';
import { PDF_INCREMENTAL_GOTO_LINK_PROFILE } from '../pdf-incremental-goto-link-artifact.mjs';
import { normalizeIncrementalGoToLink } from '../pdf-incremental-goto-link-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';
function sha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export async function handleIncrementalGoToLinkRoute(context) {
  if (context.operation !== 'incremental-goto-link') return false;
  const { request, response, url, documentId, processing, incrementalGoToLink, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST'); if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Incremental GoTo-link editing does not accept query parameters.', 400);
  if (!incrementalGoToLink) throw new HostError('INCREMENTAL_GOTO_LINK_UNAVAILABLE', 'The local incremental GoTo-link service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'sourcePage', 'targetPage', 'rect']) || body.profile !== PDF_INCREMENTAL_GOTO_LINK_PROFILE || !sha256(body.sourceSha256)) throw new HostError('INVALID_INCREMENTAL_GOTO_LINK_OPTIONS', 'Incremental GoTo links require the fixed profile, current lowercase source SHA-256, pages, and rectangle.', 400);
  let value; try { value = normalizeIncrementalGoToLink({ profile: body.profile, sourcePage: body.sourcePage, targetPage: body.targetPage, rect: body.rect }); } catch { throw new HostError('INVALID_INCREMENTAL_GOTO_LINK_OPTIONS', 'Incremental GoTo links require valid pages and rectangle.', 400); }
  const result = await incrementalGoToLink.update(documentId, value, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true; json(response, 201, { result }); return true;
}
