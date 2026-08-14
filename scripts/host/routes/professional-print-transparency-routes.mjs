import { HostError } from '../host-error.mjs';
import {
  normalizeProfessionalPrintTransparencyRequest,
  validateProfessionalPrintTransparencyResult,
  PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY,
} from '../../../src/core/professional-print-transparency-contract.js';
import { scheduleDocumentCleanup } from './artifact-response-lifecycle.mjs';

const OPERATION = 'professional-print-transparency';
const SHA256 = /^[0-9a-f]{64}$/u;

function candidateForCleanup(store, sourceId, sourceSha256, candidate) {
  const id = candidate?.outputDocumentId;
  const outputSha256 = candidate?.outputSha256;
  if (typeof id !== 'string' || id === sourceId || !SHA256.test(String(outputSha256 ?? ''))) return null;
  let document;
  try {
    document = store.getDocument(id);
  } catch {
    return null;
  }
  const primary = document?.operation?.inputs?.find((input) => input?.role === 'primary');
  if (!document || document.id !== id || document.origin !== 'derived'
    || document.sha256 !== outputSha256
    || document.operation?.type !== 'flatten-transparency'
    || primary?.documentId !== sourceId || primary?.sha256 !== sourceSha256) return null;
  return document.id;
}

async function cleanupInvalidCandidate(store, sourceId, sourceSha256, candidate) {
  if (!store || typeof store.getDocument !== 'function' || typeof store.deleteDocument !== 'function') return;
  const id = candidateForCleanup(store, sourceId, sourceSha256, candidate);
  if (!id) return;
  try {
    await store.deleteDocument(id);
  } catch (error) {
    throw new HostError('PROFESSIONAL_PRINT_CLEANUP_FAILED', 'Professional print delivery could not revoke its invalid retained output.', 500, { cause: error });
  }
}

export async function handleProfessionalPrintTransparencyRoute(context) {
  if (context.operation !== OPERATION) return false;
  const {
    request, response, url, documentId, processing, store, professionalCapabilities,
    bodyLimit, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Professional print transparency flattening does not accept query parameters.', 400);
  }
  if (!professionalCapabilities || typeof professionalCapabilities.deliverPrintSourceBound !== 'function') {
    throw new HostError('PROFESSIONAL_PRINT_UNAVAILABLE', 'Professional print transparency flattening is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  let options;
  try {
    options = normalizeProfessionalPrintTransparencyRequest(body);
  } catch (error) {
    throw new HostError('PROFESSIONAL_PRINT_OPTIONS_INVALID', 'Professional print transparency flattening requires its exact source-bound request.', 400, { cause: error });
  }
  let candidate;
  try {
    candidate = await professionalCapabilities.deliverPrintSourceBound(PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY, {
      documentId,
      sourceSha256: options.sourceSha256,
      quality: 'medium',
      signal: processing.signal,
    });
    const result = validateProfessionalPrintTransparencyResult(candidate, options, documentId);
    if (await scheduleDocumentCleanup({ processing, response, store }, result.outputDocumentId)) return true;
    json(response, 201, { result });
    return true;
  } catch (error) {
    await cleanupInvalidCandidate(store, documentId, options?.sourceSha256, candidate);
    if (error instanceof HostError) throw error;
    throw new HostError('INVALID_PROFESSIONAL_PRINT_RESULT', 'Professional print transparency flattening returned invalid local evidence.', 502, { cause: error });
  }
}
