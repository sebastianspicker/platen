import { HostError } from '../host-error.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const BODY_LIMIT = 1_024;

export async function handleOcrEditableRoute(context) {
  const { request, response, url, documentId, operation, processing, store, ocrEditableOutput, method, readJson, json } = context;
  if (operation !== 'ocr-editable') return false;
  method(request, 'POST');
  if (url.search !== '') throw new HostError('INVALID_OCR_EDITABLE_REQUEST', 'Editable OCR does not accept query parameters.', 400);
  if (!ocrEditableOutput) throw new HostError('OCR_EDITABLE_UNAVAILABLE', 'Editable OCR output is unavailable.', 503);
  const body = await readJson(request, BODY_LIMIT);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
    || Object.keys(body).some((key) => !['sourceSha256', 'language'].includes(key))
    || !SHA256.test(body.sourceSha256 ?? '') || body.language !== 'eng') {
    throw new HostError('INVALID_OCR_EDITABLE_REQUEST', 'Editable OCR requires the current source digest and fixed eng language.', 400);
  }
  const result = await ocrEditableOutput.export(documentId, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (result.sourceDigest !== body.sourceSha256 || result.artifact?.documentId !== documentId) {
    if (typeof result.artifact?.id === 'string') await store.deleteArtifact(result.artifact.id);
    throw new HostError('OCR_EDITABLE_RESULT_INVALID', 'Editable OCR returned an artifact for a different source.', 502);
  }
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
