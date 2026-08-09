import { HostError } from '../host-error.mjs';
import { PDF_PRINTER_MARKS_PROFILE } from '../pdf-printer-marks-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;

function publicPrinterMarksResult(result) {
  const artifact = result.artifact;
  return {
    kind: result.kind,
    sourceDigest: result.sourceDigest,
    artifact: {
      id: artifact.id,
      documentId: artifact.documentId,
      displayName: artifact.displayName,
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      operation: artifact.operation,
      createdAt: artifact.createdAt,
    },
    pages: result.pages,
    evidence: result.evidence,
    limitations: result.limitations,
  };
}

export async function handlePrinterMarksRoute(context) {
  if (context.operation !== 'printer-marks') return false;
  const { request, response, url, documentId, processing, printerMarks, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Printer marks does not accept query parameters.', 400);
  if (!printerMarks || typeof printerMarks.create !== 'function') throw new HostError('PRINTER_MARKS_UNAVAILABLE', 'The local printer-marks service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'pages']) || body.profile !== PDF_PRINTER_MARKS_PROFILE || !SHA256.test(body.sourceSha256)
    || !Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > 500
    || body.pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 500)
    || body.pages.some((page, index) => index > 0 && page <= body.pages[index - 1])) {
    throw new HostError('PRINTER_MARKS_OPTIONS_INVALID', 'Printer marks requires the fixed profile, current lowercase source SHA-256, and unique ascending pages.', 400);
  }
  const result = await printerMarks.create(documentId, { profile: body.profile, sourceSha256: body.sourceSha256, pages: body.pages }, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result: publicPrinterMarksResult(result) });
  return true;
}
