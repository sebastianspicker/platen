import {
  mapEngineError,
  MAX_TEXT_PAGE_COUNT,
  parsePageDimensions,
  parsePdfInfo,
  parseTextPages,
} from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';

export class PdfInspectionBasic {
  #store; #adapter;
  constructor({ store, adapter }) { this.#store = store; this.#adapter = adapter; }
  async inspect(documentId, { signal } = {}) {
    const input = this.#store.getSourcePath(documentId);
    try {
      const result = await this.#adapter.execute('inspect', { input }, {
        signal, timeoutMs: 15_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024,
      });
      return parsePdfInfo(result.stdout);
    } catch (error) { throw mapEngineError(error); }
  }
  async inspectPage(documentId, page, { signal } = {}) {
    const input = this.#store.getSourcePath(documentId);
    try {
      const result = await this.#adapter.execute('inspectPage', { input, page }, {
        signal, timeoutMs: 15_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024,
      });
      return parsePageDimensions(result.stdout, page);
    } catch (error) { throw mapEngineError(error); }
  }
  async extractText(documentId, pageCount = null, { signal } = {}) {
    if (Number.isInteger(pageCount) && pageCount > MAX_TEXT_PAGE_COUNT) {
      throw new HostError('DOCUMENT_TOO_LARGE', `Text extraction is limited to ${MAX_TEXT_PAGE_COUNT} pages per document.`, 422);
    }
    const input = this.#store.getSourcePath(documentId);
    try {
      const result = await this.#adapter.execute('extractText', { input, layout: true }, {
        signal, timeoutMs: 45_000, maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 128 * 1024,
      });
      return parseTextPages(result.stdout, pageCount);
    } catch (error) { throw mapEngineError(error); }
  }
}
