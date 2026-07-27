import { HostError } from '../host-error.mjs';
import { FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_PROFILE } from '../pdf-full-page-redaction-writer.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export async function handleFullPageRedactionRoute(context) {
  if (context.operation !== 'full-page-redaction') return false;
  const { request, response, url, documentId, processing, fullPageRedaction, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Full-page redaction does not accept query parameters.', 400);
  if (!fullPageRedaction) throw new HostError('FULL_PAGE_REDACTION_UNAVAILABLE', 'The local full-page redaction service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'page']) || body.profile !== FULL_PAGE_REDACTION_PROFILE || !SHA256.test(body.sourceSha256)) {
    throw new HostError('INVALID_FULL_PAGE_REDACTION_OPTIONS', 'Full-page redaction requires the fixed profile, current lowercase source SHA-256, and page.', 400);
  }
  if (!Number.isSafeInteger(body.page) || body.page < 1 || body.page > 100) throw new HostError('INVALID_FULL_PAGE_REDACTION_OPTIONS', 'Full-page redaction requires one page from 1 through 100.', 400);
  const result = await fullPageRedaction.update(documentId, { profile: body.profile, sourceSha256: body.sourceSha256, page: body.page }, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}

export async function handleFullPageRedactionBatchRoute(context) {
  if (context.operation !== 'full-page-redaction-batch') return false;
  const { request, response, url, documentId, processing, fullPageRedaction, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Full-page redaction batch does not accept query parameters.', 400);
  if (!fullPageRedaction || typeof fullPageRedaction.updateBatch !== 'function') throw new HostError('FULL_PAGE_REDACTION_UNAVAILABLE', 'The local full-page redaction batch service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'pages']) || body.profile !== FULL_PAGE_REDACTION_BATCH_PROFILE || !SHA256.test(body.sourceSha256)
    || !Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > 32
    || body.pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 100)
    || body.pages.some((page, index) => index > 0 && page <= body.pages[index - 1])) {
    throw new HostError('INVALID_FULL_PAGE_REDACTION_BATCH_OPTIONS', 'Full-page redaction batch requires the fixed profile, current lowercase source SHA-256, and unique ascending pages.', 400);
  }
  const result = await fullPageRedaction.updateBatch(documentId, { profile: body.profile, sourceSha256: body.sourceSha256, pages: body.pages }, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
