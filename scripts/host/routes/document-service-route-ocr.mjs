import {
  normalizeOcrDocumentRequest,
  normalizeOcrLayoutRequest,
  validateOcrDocumentResult,
  validateOcrLayoutResult,
} from '../../../src/core/ocr-contract.js';
import { HostError } from '../host-error.mjs';

export async function handleDocumentOcrRoute(context) {
  if (context.operation === 'ocr') return processOcr(context);
  if (context.operation === 'ocr-analysis') return analyzeOcr(context);
  return rewriteDocument(context);
}

async function processOcr({ request, response, url, documentId, processing, service, method, json, readJson, normalizedOcrOptions, checkedOcrResult }) {
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'OCR processing does not accept query parameters.', 400);
  const options = await normalizedOcrOptions(service, processing, await readJson(request), normalizeOcrDocumentRequest, 'INVALID_OCR_OPTIONS');
  json(response, 201, checkedOcrResult(await service.ocrDocument(documentId, { ...options, ...processing }), validateOcrDocumentResult));
}

async function analyzeOcr({ request, response, url, documentId, processing, service, method, json, readJson, normalizedOcrOptions, checkedOcrResult }) {
  if (typeof service.analyzeOcrLayout !== 'function') throw new HostError('OCR_ANALYSIS_UNAVAILABLE', 'Local OCR layout analysis is unavailable.', 503);
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'OCR layout analysis does not accept query parameters.', 400);
  const options = await normalizedOcrOptions(service, processing, await readJson(request), normalizeOcrLayoutRequest, 'INVALID_OCR_OPTIONS');
  json(response, 200, { result: checkedOcrResult(await service.analyzeOcrLayout(documentId, { ...options, ...processing }), validateOcrLayoutResult) });
}

async function rewriteDocument({ request, response, documentId, processing, conversion, method, json, readJson }) {
  if (!conversion) throw new HostError('CONVERSION_UNAVAILABLE', 'Local PDF rewriting is unavailable.', 503);
  method(request, 'POST');
  const body = await readJson(request);
  json(response, 201, { document: await conversion.rewriteDocument(documentId, body.mode, processing) });
}
