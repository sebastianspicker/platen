import { HostError } from '../host-error.mjs';
import { PDF_ACROFORM_DATA_EXPORT_PROFILE, snapshotAcroFormDataExportRequest, validateAcroFormDataExportResult } from '../pdf-acroform-data-export-contract.mjs';

export async function handleAcroFormDataExportRoute(context) {
  if (context.operation !== 'acroform-data-export') return false;
  const { request, response, url, documentId, processing, store, acroFormDataExport, bodyLimit, method, readJson, json, exactJsonObject } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'AcroForm data export does not accept query parameters.', 400);
  if (!acroFormDataExport || typeof acroFormDataExport.export !== 'function') throw new HostError('ACROFORM_DATA_EXPORT_UNAVAILABLE', 'The local AcroForm data export service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  let fixed; try { fixed = snapshotAcroFormDataExportRequest(body); if (exactJsonObject && !exactJsonObject(body, ['profile', 'sourceSha256'])) throw new Error(); } catch { throw new HostError('INVALID_ACROFORM_DATA_EXPORT_OPTIONS', 'The AcroForm data export request is invalid.', 400); }
  if (fixed.profile !== PDF_ACROFORM_DATA_EXPORT_PROFILE) throw new HostError('INVALID_ACROFORM_DATA_EXPORT_OPTIONS', 'The AcroForm data export request is invalid.', 400);
  let source; try { source = store.getDocument(documentId); } catch (error) { throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'The AcroForm source document is unavailable.', 404, { cause: error }); }
  if (source.sha256 !== fixed.sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'The data export source digest does not match the current document.', 409);
  const result = await acroFormDataExport.export(documentId, fixed, { signal: processing.signal });
  if (processing.signal.aborted || response.destroyed) return true;
  if (!validateAcroFormDataExportResult(result, { sourceSha256: fixed.sourceSha256 })) throw new HostError('ACROFORM_DATA_EXPORT_RESULT_INVALID', 'The AcroForm data export service returned invalid evidence.', 502);
  json(response, 200, { result: structuredClone(result) });
  return true;
}
