import { HostError } from '../host-error.mjs';
import { PDF_PAGE_LABELS_PROFILE, normalizePdfPageLabels } from '../pdf-page-labels-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handlePageLabelsRoute({ request, response, url, documentId, operation, processing, store, pageLabels, pageLabelsReady, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'page-labels') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Page-label authoring does not accept query parameters.', 400);
  if (!pageLabelsReady || !pageLabels) throw new HostError('PDF_PAGE_LABELS_UNAVAILABLE', 'Page-label authoring is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'ranges']) || body.profile !== PDF_PAGE_LABELS_PROFILE || !/^[0-9a-f]{64}$/u.test(body.sourceSha256)) throw new HostError('INVALID_PDF_PAGE_LABELS_OPTIONS', 'Page-label authoring requires the fixed profile, current source digest, and canonical ranges.', 400);
  try { normalizePdfPageLabels(body); } catch (error) { throw new HostError('INVALID_PDF_PAGE_LABELS_OPTIONS', 'Page-label ranges are outside the bounded canonical contract.', 400, { cause: error }); }
  const result = await pageLabels.create(documentId, body, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result }); return true;
}
