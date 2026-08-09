import { HostError } from '../host-error.mjs';
import { normalizePdfXfaInspectionRequest, PDF_XFA_INSPECTION_PROFILE } from '../pdf-xfa-inspection-contract.mjs';
import { validatePdfXfaInspectionResult } from '../../../src/core/local-host-xfa-inspection-endpoints.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export async function handleXfaInspectionRoute({
  request, response, url, operation, documentId, processing, xfaInspection,
  bodyLimit, exactJsonObject, method, readJson, json,
}) {
  if (operation !== 'xfa-inspection') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'XFA inspection does not accept query parameters.', 400);
  if (!xfaInspection || typeof xfaInspection.inspect !== 'function') throw new HostError('PDF_XFA_INSPECTION_UNAVAILABLE', 'XFA inspection is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256']) || body.profile !== PDF_XFA_INSPECTION_PROFILE || !SHA256.test(body.sourceSha256 ?? '')) {
    throw new HostError('PDF_XFA_INSPECTION_OPTIONS_INVALID', 'XFA inspection requires the fixed profile and current lowercase source SHA-256.', 400);
  }
  try { normalizePdfXfaInspectionRequest(body); } catch (error) { throw new HostError('PDF_XFA_INSPECTION_OPTIONS_INVALID', 'XFA inspection options are outside the bounded canonical contract.', 400, { cause: error }); }
  const result = await xfaInspection.inspect(documentId, body, { signal: processing.signal });
  try { validatePdfXfaInspectionResult(result, body.sourceSha256); } catch (error) { throw new HostError('PDF_XFA_INSPECTION_OUTPUT_INVALID', 'XFA inspection returned invalid privacy-minimal evidence.', 502, { cause: error }); }
  json(response, 200, { result });
  return true;
}

export const handlePdfXfaInspectionRoute = handleXfaInspectionRoute;
