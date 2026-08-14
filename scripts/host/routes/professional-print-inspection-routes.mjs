import { HostError } from '../host-error.mjs';
import {
  normalizeProfessionalPrintInspectionRequest,
  validateProfessionalPrintInspectionResult,
} from '../../../src/core/professional-print-inspection-contract.js';

const OPERATION = 'professional-print-inspection';

export async function handleProfessionalPrintInspectionRoute(context) {
  if (context.operation !== OPERATION) return false;
  const {
    request, response, url, documentId, processing, professionalCapabilities,
    bodyLimit, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Professional print inspection does not accept query parameters.', 400);
  }
  if (!professionalCapabilities || typeof professionalCapabilities.deliverPrintSourceBound !== 'function') {
    throw new HostError('PROFESSIONAL_PRINT_UNAVAILABLE', 'Professional print inspection is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  let options;
  try {
    options = normalizeProfessionalPrintInspectionRequest(body);
  } catch (error) {
    throw new HostError('PROFESSIONAL_PRINT_OPTIONS_INVALID', 'Professional print inspection requires its exact source-bound request.', 400, { cause: error });
  }
  let result;
  try {
    result = await professionalCapabilities.deliverPrintSourceBound(options.capabilityId, {
      documentId,
      sourceSha256: options.sourceSha256,
      signal: processing.signal,
    });
    result = validateProfessionalPrintInspectionResult(result, options);
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError('INVALID_PROFESSIONAL_PRINT_RESULT', 'Professional print inspection returned invalid local evidence.', 502, { cause: error });
  }
  json(response, 200, { result });
  return true;
}
