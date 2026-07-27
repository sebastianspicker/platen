import { ocrLayoutHtml, ocrTableCsv } from '../core/ocr-layout-export.js';

const ALTO_MAX_BYTES = 2 * 1024 * 1024;
const ALTO_MAX_BASE64_CHARACTERS = 2_796_208;
const SHA256 = /^[a-f0-9]{64}$/;
const VALID_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function createOcrEvidenceExporter({
  state,
  triggerDownload,
  showError,
  decodeBase64 = globalThis.atob,
  cryptoApi = globalThis.crypto,
}) {
  if (!state || typeof triggerDownload !== 'function' || typeof showError !== 'function') {
    throw new TypeError('OCR evidence exporter requires state and output callbacks.');
  }

  async function decodedAltoBlob(alto) {
    const data = alto?.data;
    const byteLength = alto?.byteLength;
    if (alto?.mediaType !== 'application/alto+xml' || alto.encoding !== 'base64'
      || typeof data !== 'string' || data.length > ALTO_MAX_BASE64_CHARACTERS
      || !VALID_BASE64.test(data)
      || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > ALTO_MAX_BYTES
      || !SHA256.test(alto.sha256 ?? '')) {
      throw new Error('The local ALTO evidence is malformed or exceeds the export limit.');
    }
    if (typeof decodeBase64 !== 'function') {
      throw new Error('This browser cannot decode the local ALTO evidence.');
    }
    const decoded = decodeBase64(data);
    if (decoded.length !== byteLength) {
      throw new Error('The local ALTO evidence length does not match its record.');
    }
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    if (!cryptoApi?.subtle) {
      throw new Error('This browser cannot verify the local ALTO evidence digest.');
    }
    const digest = [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== alto.sha256) {
      throw new Error('The local ALTO evidence digest does not match its record.');
    }
    return new Blob([bytes], { type: 'application/alto+xml' });
  }

  async function exportOcrLayout(format) {
    const result = state.ocrLayoutResult;
    if (!result) return;
    try {
      const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
      if (format === 'json') {
        triggerDownload({
          blob: new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
          fileName: `${stem}-ocr-layout.json`,
          message: 'Local OCR coordinates and review evidence exported as JSON.',
        });
        return;
      }
      if (format === 'html') {
        triggerDownload({
          blob: new Blob([ocrLayoutHtml(result)], { type: 'text/html' }),
          fileName: `${stem}-ocr-layout.html`,
          message: 'Local OCR coordinates exported as a self-contained HTML review file.',
        });
        return;
      }
      if (format === 'alto') {
        const record = result.records?.[state.selectedOcrRecordIndex];
        if (!record?.alto) throw new Error('No ALTO XML evidence is available for this OCR result.');
        triggerDownload({
          blob: await decodedAltoBlob(record.alto),
          fileName: `${stem}-page-${record.page}-${record.zoneId || 'region'}.alto.xml`,
          message: `Tesseract ALTO XML evidence exported for page ${record.page}.`,
        });
        return;
      }
      if (format === 'table-csv') {
        const records = Array.isArray(result.records) ? result.records : [];
        const recordIndex = state.selectedOcrRecordIndex;
        const candidateIndex = state.selectedOcrTableCandidate;
        if (!Number.isSafeInteger(recordIndex) || !Number.isSafeInteger(candidateIndex)) {
          throw new Error('Select a result record and table candidate before exporting CSV.');
        }
        const record = records[recordIndex];
        const candidate = record?.tableCandidates?.[candidateIndex];
        if (!Array.isArray(candidate?.grid)) {
          throw new Error('The selected table candidate has no reviewable grid.');
        }
        triggerDownload({
          blob: new Blob([ocrTableCsv(result, { recordIndex, candidateIndex })], {
            type: 'text/csv;charset=utf-8',
          }),
          fileName: `${stem}-page-${record.page}-${record.zoneId || 'region'}-ocr-table.csv`,
          message: `Formula-safe CSV exported from a geometry-based OCR table candidate on page ${record.page}${candidate.truncated ? ' with bounded/truncated content' : ''}; human review is required.`,
        });
        return;
      }
      throw new Error('Unknown OCR layout export format.');
    } catch (error) {
      showError(error);
    }
  }

  return Object.freeze({ decodedAltoBlob, exportOcrLayout });
}
