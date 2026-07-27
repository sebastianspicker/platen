import { HostError } from '../host-error.mjs';
import { normalizePageTextRequest, PDF_PAGE_TEXT_PROFILE } from '../pdf-page-text-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export async function handlePageTextRoute(context) {
  if (context.operation !== 'page-text') return false;
  const {
    request, response, url, documentId, processing, pageText, bodyLimit,
    exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Page-text insertion does not accept query parameters.', 400);
  }
  if (!pageText) {
    throw new HostError('PDF_PAGE_TEXT_UNAVAILABLE', 'The local page-text service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'page', 'x', 'y', 'size', 'text'])
    || body.profile !== PDF_PAGE_TEXT_PROFILE || !SHA256.test(body.sourceSha256)) {
    throw new HostError('INVALID_PAGE_TEXT_OPTIONS', 'Page-text insertion requires the fixed profile, current lowercase source SHA-256, page, integer position and size, and printable ASCII text.', 400);
  }
  let value;
  try {
    value = normalizePageTextRequest({
      profile: body.profile, page: body.page, x: body.x, y: body.y,
      size: body.size, text: body.text,
    });
  } catch {
    throw new HostError('INVALID_PAGE_TEXT_OPTIONS', 'Page-text insertion requires one valid page and a canonical printable-ASCII text run.', 400);
  }
  const result = await pageText.insert(documentId, {
    ...value, sourceSha256: body.sourceSha256, signal: processing.signal,
  });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
