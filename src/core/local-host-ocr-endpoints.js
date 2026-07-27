import { PlatenError } from './errors.js';
import { normalizeOcrBatchRequest, normalizeOcrDocumentRequest, normalizeOcrLayoutRequest, validateOcrBatchManifest, validateOcrDocumentResult, validateOcrLayoutResult } from './ocr-contract.js';

export function createOcrEndpoints({ json }) {
  return {
    ocrDocument(documentId, language = 'eng', { signal } = {}) {
      const options = typeof language === 'string' ? { language } : language;
      const requestedLanguages = typeof options?.language === 'string' ? options.language.split('+') : ['eng'];
      const normalized = normalizeOcrDocumentRequest(options, requestedLanguages);
      return json(`/api/documents/${encodeURIComponent(documentId)}/ocr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized), signal }).then((body) => {
        const output = validateOcrDocumentResult(body);
        if (output.artifact.documentId !== documentId) {
          throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned OCR output for a different document.');
        }
        return output;
      });
    },
    analyzeOcrLayout(documentId, options = {}, { signal } = {}) {
      const requestedLanguages = typeof options?.language === 'string' ? options.language.split('+') : ['eng'];
      const normalized = normalizeOcrLayoutRequest(options, requestedLanguages);
      return json(`/api/documents/${encodeURIComponent(documentId)}/ocr-analysis`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized), signal }).then((body) => validateOcrLayoutResult(body.result));
    },
    ocrBatch(request, installedLanguages, { signal } = {}) {
      const normalized = normalizeOcrBatchRequest(request, installedLanguages);
      return json('/api/ocr/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized), signal }).then((body) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'manifest')) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid OCR batch response.');
        const manifest = validateOcrBatchManifest(body.manifest);
        if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(manifest.status) || !Array.isArray(manifest.requests) || manifest.requests.length !== normalized.requests.length) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned incomplete OCR batch results.');
        const results = manifest.requests.map((entry, index) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.id !== normalized.requests[index].id || entry.documentId !== normalized.requests[index].documentId || entry.kind !== normalized.requests[index].kind || !['completed', 'failed', 'cancelled'].includes(entry.status)) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid OCR batch item.');
          if (entry.status === 'completed') { const output = validateOcrDocumentResult(entry.output); if (!output.artifact?.id) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host OCR batch artifact is invalid.'); return Object.freeze({ id: entry.id, status: entry.status, artifact: output.artifact, output }); }
          if (!entry.error || typeof entry.error.code !== 'string' || !entry.error.code || typeof entry.error.message !== 'string' || !entry.error.message) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host OCR batch failure is invalid.');
          return Object.freeze({ id: entry.id, status: entry.status, artifact: null, error: Object.freeze({ code: entry.error.code, message: entry.error.message }) });
        });
        return Object.freeze({ manifest, results: Object.freeze(results) });
      });
    },
  };
}
