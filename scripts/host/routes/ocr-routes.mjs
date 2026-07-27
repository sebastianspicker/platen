import { HostError } from '../host-error.mjs';
import { normalizeOcrBatchRequest, validateOcrBatchManifest } from '../../../src/core/ocr-contract.js';

export async function handleOcrRoute(context) {
  const {
    pathname, request, response, url, service, processing,
    method, json, readJson, normalizedOcrOptions, checkedOcrResult,
  } = context;
  if (pathname === '/api/ocr/languages') {
    method(request, 'GET');
    json(response, 200, { languages: await service.ocrLanguages(processing) });
    return true;
  }
  if (pathname !== '/api/ocr/batch') return false;

  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'OCR batch processing does not accept query parameters.', 400);
  }
  if (typeof service.ocrBatchDocuments !== 'function') {
    throw new HostError('OCR_BATCH_UNAVAILABLE', 'Local OCR batch processing is unavailable.', 503);
  }
  const normalized = await normalizedOcrOptions(
    service, processing, await readJson(request), normalizeOcrBatchRequest, 'INVALID_OCR_BATCH',
  );
  const manifest = checkedOcrResult(
    await service.ocrBatchDocuments(normalized.requests, processing), validateOcrBatchManifest,
  );
  json(response, 200, { manifest });
  return true;
}
