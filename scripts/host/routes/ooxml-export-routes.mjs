import { HostError } from '../host-error.mjs';

const PROFILE = 'local-pdf-ooxml-export-v1';
const FORMATS = new Set(['word', 'excel', 'powerpoint']);

export async function handleOoxmlExportRoute({ pathname, request, response, documentId, ooxmlExport, processing, method, readJson, exactJsonObject, json, bodyLimit }) {
  if (pathname !== `/api/documents/${encodeURIComponent(documentId)}/export-ooxml`) return false;
  method(request, 'POST');
  if (!ooxmlExport || typeof ooxmlExport.export !== 'function') throw new HostError('OOXML_EXPORT_UNAVAILABLE', 'OOXML export is not available in this local host.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'format'])
    || body.profile !== PROFILE || !/^[a-f0-9]{64}$/u.test(body.sourceSha256 ?? '') || !FORMATS.has(body.format)) {
    throw new HostError('INVALID_OOXML_EXPORT_OPTIONS', 'OOXML export requires the fixed profile, source digest, and format.', 400);
  }
  const result = await ooxmlExport.export(documentId, body.format, { sourceSha256: body.sourceSha256, signal: processing.signal });
  const { bytes: _bytes, ...publicResult } = result;
  json(response, 201, { result: publicResult });
  return true;
}

export { PROFILE as OOXML_EXPORT_PROFILE };
