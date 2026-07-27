import {
  PDF_PRINTER_MARKS_PROFILE, validPrinterMarksRequest, validatePrinterMarksResult,
} from './pdf-printer-marks-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export function createPrinterMarksEndpoints({ json }) {
  return Object.freeze({
    createPrinterMarks(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !validPrinterMarksRequest(request)
        || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Printer-marks options are invalid.');
      const fixedRequest = Object.freeze({ pages: Object.freeze([...request.pages]) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/printer-marks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256, pages: fixedRequest.pages }), signal: options.signal,
      }).then((body) => validatePrinterMarksResult(body?.result, { documentId, sourceSha256, request: fixedRequest }));
    },
  });
}
