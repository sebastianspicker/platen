import { HostError } from '../host-error.mjs';
import {
  PDF_SENSITIVE_PATTERN_PROFILE,
  normalizePdfSensitivePatternRequest,
  validatePdfSensitivePatternResult,
} from '../../../src/core/pdf-sensitive-pattern-contract.js';

export async function handleSensitivePatternRoute(context) {
  if (context.operation !== 'sensitive-patterns') return false;
  const {
    request, response, url, documentId, processing, sensitivePatterns,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Sensitive-pattern detection does not accept query parameters.', 400);
  if (!sensitivePatterns || typeof sensitivePatterns.find !== 'function') {
    throw new HostError('PDF_SENSITIVE_PATTERN_UNAVAILABLE', 'Sensitive-pattern detection is unavailable.', 503);
  }
  let body;
  try {
    body = await readJson(request, bodyLimit);
  } catch (error) {
    throw new HostError('INVALID_PDF_SENSITIVE_PATTERN_OPTIONS', 'Sensitive-pattern options are outside the bounded canonical contract.', 400, { cause: error });
  }
  let exactRequest = false;
  try {
    exactRequest = exactJsonObject(body, ['profile', 'sourceSha256', 'customPatterns'])
      && body.profile === PDF_SENSITIVE_PATTERN_PROFILE;
  } catch (error) {
    throw new HostError('INVALID_PDF_SENSITIVE_PATTERN_OPTIONS', 'Sensitive-pattern options are outside the bounded canonical contract.', 400, { cause: error });
  }
  if (!exactRequest) {
    throw new HostError('INVALID_PDF_SENSITIVE_PATTERN_OPTIONS', 'Sensitive-pattern detection requires the fixed profile, source digest, and exact custom-pattern request.', 400);
  }
  let normalized;
  try {
    normalized = normalizePdfSensitivePatternRequest(body);
  } catch (error) {
    throw new HostError('INVALID_PDF_SENSITIVE_PATTERN_OPTIONS', 'Sensitive-pattern options are outside the bounded canonical contract.', 400, { cause: error });
  }
  let result;
  try {
    result = await sensitivePatterns.find(documentId, normalized, { signal: processing.signal });
    validatePdfSensitivePatternResult(result, {
      documentId,
      sourceSha256: normalized.sourceSha256,
      request: normalized,
    });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' || error?.code === 'ENGINE_CANCELLED') throw error;
    if (error instanceof HostError) throw error;
    throw new HostError('PDF_SENSITIVE_PATTERN_OUTPUT_INVALID', 'Sensitive-pattern detection returned invalid evidence.', 502, { cause: error });
  }
  json(response, 200, { result });
  return true;
}
