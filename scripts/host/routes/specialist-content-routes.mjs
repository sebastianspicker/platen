import { HostError } from '../host-error.mjs';
import { PDF_SPECIALIST_CONTENT_PROFILE, normalizePdfSpecialistContent } from '../pdf-specialist-content-contract.mjs';

export async function handleSpecialistContentRoute({ request, response, url, operation, documentId, processing, specialistContent, specialistContentReady, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'specialist-content') return false;
  method(request, 'POST'); if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Specialist-content inspection does not accept query parameters.', 400);
  if (!specialistContentReady || !specialistContent || typeof specialistContent.inspect !== 'function') throw new HostError('PDF_SPECIALIST_CONTENT_UNAVAILABLE', 'Specialist-content inspection is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256']) || body.profile !== PDF_SPECIALIST_CONTENT_PROFILE) throw new HostError('PDF_SPECIALIST_CONTENT_OPTIONS_INVALID', 'Specialist-content inspection requires the fixed profile and current source digest.', 400);
  try { normalizePdfSpecialistContent(body); } catch (error) { throw new HostError('PDF_SPECIALIST_CONTENT_OPTIONS_INVALID', 'Specialist-content options are outside the bounded canonical contract.', 400, { cause: error }); }
  const result = await specialistContent.inspect(documentId, body, { sourceSha256: body.sourceSha256, signal: processing.signal });
  json(response, 200, { result }); return true;
}
