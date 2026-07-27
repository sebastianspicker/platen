import { HostError } from '../host-error.mjs';
import { normalizePdfPageBackground } from '../pdf-page-background-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handlePageBackgroundRoute(context) {
  if (context.operation !== 'page-background') return false;
  const { request, response, url, documentId, processing, pageBackground, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Page background does not accept query parameters.', 400);
  if (!pageBackground || typeof pageBackground.create !== 'function') throw new HostError('PAGE_BACKGROUND_UNAVAILABLE', 'The local page-background service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'pages', 'color'])) throw new HostError('PAGE_BACKGROUND_OPTIONS_INVALID', 'Page background requires the fixed profile, source SHA-256, pages, and RGB color.', 400);
  try { normalizePdfPageBackground(body); } catch (error) { throw new HostError('PAGE_BACKGROUND_OPTIONS_INVALID', 'Page background requires unique ascending pages and finite RGB components.', 400, { cause: error }); }
  const result = await pageBackground.create(documentId, body, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
