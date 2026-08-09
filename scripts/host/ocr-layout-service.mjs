import { HostError } from './host-error.mjs';

/**
 * Small compatibility boundary for layout OCR consumers. The pipeline owns
 * engine execution and workspace cleanup; this service keeps route, client,
 * and CLI callers on one cancellation-aware method name.
 */
export class OcrLayoutService {
  #pipeline; #lock;

  constructor({ pipeline, lock } = {}) {
    if (!pipeline || typeof pipeline.analyze !== 'function') {
      throw new TypeError('OcrLayoutService requires an OCR layout pipeline.');
    }
    if (!lock || typeof lock.run !== 'function') throw new TypeError('OcrLayoutService requires the shared OCR job lock.');
    this.#pipeline = pipeline; this.#lock = lock;
  }

  analyze(documentId, options = {}) {
    return this.#pipeline.analyze(documentId, options, this.#lock);
  }

  analyzeOcrLayout(...args) {
    return this.analyze(...args);
  }
}

export function assertOcrLayoutService(service) {
  if (!service || typeof service.analyzeOcrLayout !== 'function') {
    throw new HostError('OCR_ANALYSIS_UNAVAILABLE', 'Local OCR layout analysis is unavailable.', 503);
  }
  return service;
}
