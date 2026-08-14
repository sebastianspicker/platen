import { mapEngineError, MAX_OCR_BATCH_BYTES, MAX_OCR_BATCH_DOCUMENTS, MAX_OCR_PAGES, validateOcrMode } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { OcrDocumentPipeline } from './ocr-document-pipeline.mjs';
import { OcrJobLock, ocrLanguages } from './ocr-job-helpers.mjs';
import { OcrLayoutPipeline } from './ocr-layout-pipeline.mjs';
import { OcrLayoutService } from './ocr-layout-service.mjs';
import { normalizeOcrUserDictionary } from '../../src/core/ocr-contract.js';

// Compatibility facade: document OCR, layout OCR, and batches share one host reservation.
export class PdfOcrService {
  #store; #inspection; #ocrAdapter; #lock; #documentPipeline; #layoutPipeline; #layoutService;

  constructor({ store, adapter, ocrAdapter, ocrImageAdapter, inspection }) {
    this.#store = store;
    this.#inspection = inspection;
    this.#ocrAdapter = ocrAdapter;
    this.#lock = new OcrJobLock();
    const dependencies = { store, adapter, ocrAdapter, ocrImageAdapter, inspection };
    this.#documentPipeline = new OcrDocumentPipeline(dependencies);
    this.#layoutPipeline = new OcrLayoutPipeline(dependencies);
    this.#layoutService = new OcrLayoutService({ pipeline: this.#layoutPipeline, lock: this.#lock });
  }

  async ocrLanguages({ signal } = {}) {
    return ocrLanguages(this.#ocrAdapter, { signal });
  }

  async ocrDocument(documentId, options = {}) {
    return this.#lock.run(() => this.#documentPipeline.run(documentId, options));
  }

  async analyzeOcrLayout(documentId, options = {}) {
    // Layout option validation remains in its pipeline before the shared reservation.
    return this.#layoutService.analyzeOcrLayout(documentId, options);
  }

  async ocrBatchDocuments(requests, { signal: externalSignal } = {}) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_OCR_BATCH_DOCUMENTS) {
      throw new HostError('INVALID_OCR_BATCH', `Choose one through ${MAX_OCR_BATCH_DOCUMENTS} OCR document requests.`, 400);
    }
    const checked = requests.map((request, index) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).sort().join(',') !== 'documentId,id,kind,options'
        || request.id !== index + 1 || request.kind !== 'document' || typeof request.documentId !== 'string') {
        throw new HostError('INVALID_OCR_BATCH', `OCR batch item ${index + 1} must be an ordered document request.`, 400);
      }
      const options = request.options ?? {};
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => !['language', 'cleanupPreset', 'segmentation', 'userDictionary'].includes(key))) {
        throw new HostError('INVALID_OCR_BATCH', `OCR batch item ${index + 1} options must contain only supported OCR fields.`, 400);
      }
      const { documentId, language = 'eng', cleanupPreset = 'none', segmentation = 'auto' } = { ...options, documentId: request.documentId };
      validateOcrMode(cleanupPreset, segmentation);
      const userDictionary = normalizeOcrUserDictionary(options.userDictionary);
      return Object.freeze({ id: request.id, documentId, kind: 'document', options: Object.freeze({ language, cleanupPreset, segmentation, userDictionary }) });
    });
    return this.#lock.run(async () => {
      let aggregatePages = 0; let aggregateInputBytes = 0;
      for (const request of checked) {
        const source = this.#store.getDocument(request.documentId);
        aggregateInputBytes += source.size;
        if (aggregateInputBytes > MAX_OCR_BATCH_BYTES) throw new HostError('OCR_BATCH_INPUT_LIMIT', 'OCR batch input exceeds the 512 MiB local limit.', 413);
        const inspection = await this.#inspection.inspect(request.documentId, { signal: externalSignal });
        aggregatePages += inspection.pageCount;
        if (aggregatePages > MAX_OCR_PAGES) throw new HostError('OCR_BATCH_PAGE_LIMIT', `OCR batch is limited to ${MAX_OCR_PAGES} aggregate pages.`, 422);
      }
      const records = []; let aggregateOutputBytes = 0; let stoppedError = null;
      for (const request of checked) {
        if (externalSignal?.aborted) {
          records.push(Object.freeze({ id: request.id, documentId: request.documentId, kind: 'document', status: 'cancelled', error: Object.freeze({ code: 'JOB_CANCELLED', message: 'The local OCR batch was cancelled.' }) }));
          continue;
        }
        if (stoppedError) {
          records.push(Object.freeze({ id: request.id, documentId: request.documentId, kind: 'document', status: 'failed', error: Object.freeze({ code: stoppedError.code, message: stoppedError.message }) }));
          continue;
        }
        try {
          const maximumOutputBytes = MAX_OCR_BATCH_BYTES - aggregateInputBytes - aggregateOutputBytes;
          const output = await this.#documentPipeline.run(request.documentId, { ...request.options, maximumOutputBytes, signal: externalSignal });
          aggregateOutputBytes += output.artifact.size ?? 0;
          if (aggregateInputBytes + aggregateOutputBytes > MAX_OCR_BATCH_BYTES) throw new HostError('OCR_BATCH_OUTPUT_LIMIT', 'OCR batch input and output exceed the 512 MiB local limit.', 413);
          records.push(Object.freeze({ id: request.id, documentId: request.documentId, kind: 'document', status: 'completed', output }));
        } catch (error) {
          const mapped = mapEngineError(error);
          records.push(Object.freeze({ id: request.id, documentId: request.documentId, kind: 'document', status: mapped.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed', error: Object.freeze({ code: mapped.code ?? 'OCR_FAILED', message: mapped.message ?? 'Local OCR failed.' }) }));
          if (mapped.code === 'ENGINE_HOST_UNHEALTHY') stoppedError = mapped;
        }
      }
      const completed = records.filter((item) => item.status === 'completed').length;
      const cancelled = records.some((item) => item.status === 'cancelled');
      return Object.freeze({
        kind: 'ocr-batch-manifest', schemaVersion: 1,
        status: completed === records.length ? 'succeeded' : completed ? 'partial' : cancelled ? 'cancelled' : 'failed',
        requests: Object.freeze(records),
        evidence: Object.freeze({ localOnly: true, sourceBound: true, engines: Object.freeze(['Poppler', 'ImageMagick', 'Tesseract']), ordered: true, sequential: true, aggregatePages, aggregateInputBytes, aggregateOutputBytes }),
        limitations: Object.freeze(['Batch OCR runs sequentially in one local host reservation and stops starting work after cancellation or host-health failure.']),
      });
    });
  }
}
