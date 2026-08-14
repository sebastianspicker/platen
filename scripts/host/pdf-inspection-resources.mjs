import {
  mapEngineError, MAX_STRUCTURE_PAGE_RANGE, parseAttachments, parseCustomMetadata,
  parseDocumentUrls, parseFonts, parseImages, parseNamedDestinations, parsePageBoxes,
  parseTaggedStructure, parseXmpMetadata,
} from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';

export class PdfInspectionResources {
  #store; #adapter; #inspect;
  constructor({ store, adapter, inspect }) { this.#store = store; this.#adapter = adapter; this.#inspect = inspect; }
  async inspectStructure(documentId, { firstPage = 1, lastPage = null, includeTagText = false, signal } = {}) {
    if (typeof includeTagText !== 'boolean') throw new HostError('INVALID_PARAMETER', 'includeTagText must be a boolean.', 400);
    const document = this.#store.getDocument(documentId);
    await this.#store.verifySource(documentId);
    const inspection = await this.#inspect(documentId, { signal });
    const resolvedLastPage = lastPage ?? Math.min(inspection.pageCount, firstPage + MAX_STRUCTURE_PAGE_RANGE - 1);
    if (!Number.isSafeInteger(firstPage) || !Number.isSafeInteger(resolvedLastPage)
      || firstPage < 1 || resolvedLastPage < firstPage || resolvedLastPage > inspection.pageCount
      || resolvedLastPage - firstPage + 1 > MAX_STRUCTURE_PAGE_RANGE) {
      throw new HostError('INVALID_PAGE_RANGE', `Structural inspection is limited to ${MAX_STRUCTURE_PAGE_RANGE} pages per request.`, 400);
    }
    const input = this.#store.getSourcePath(documentId);
    await this.#store.verifySource(documentId);
    try {
      const options = { signal, timeoutMs: 30_000, maxStderrBytes: 128 * 1024 };
      const [boxes, metadata, custom, destinations, urls, structure] = await Promise.all([
        this.#adapter.execute('inspectPageBoxes', { input, firstPage, lastPage: resolvedLastPage }, { ...options, maxStdoutBytes: 4 * 1024 * 1024 }),
        this.#adapter.execute('inspectMetadata', { input }, { ...options, maxStdoutBytes: 4 * 1024 * 1024 }),
        this.#adapter.execute('inspectCustomMetadata', { input }, { ...options, maxStdoutBytes: 2 * 1024 * 1024 }),
        this.#adapter.execute('inspectDestinations', { input }, { ...options, maxStdoutBytes: 4 * 1024 * 1024 }),
        this.#adapter.execute('inspectUrls', { input }, { ...options, maxStdoutBytes: 4 * 1024 * 1024 }),
        this.#adapter.execute('inspectStructure', { input, includeText: includeTagText }, { ...options, maxStdoutBytes: includeTagText ? 16 * 1024 * 1024 : 4 * 1024 * 1024 }),
      ]);
      await this.#store.verifySource(documentId);
      return Object.freeze({
        sourceDigest: document.sha256, pageCount: inspection.pageCount,
        pageRange: Object.freeze({ firstPage, lastPage: resolvedLastPage, truncated: resolvedLastPage < inspection.pageCount }),
        pageBoxes: parsePageBoxes(boxes.stdout, { firstPage, lastPage: resolvedLastPage }),
        xmpMetadata: parseXmpMetadata(metadata.stdout), customMetadata: parseCustomMetadata(custom.stdout),
        namedDestinations: parseNamedDestinations(destinations.stdout, { pageCount: inspection.pageCount }),
        urls: parseDocumentUrls(urls.stdout), taggedStructure: parseTaggedStructure(structure.stdout, { includesText: includeTagText }),
        engine: Object.freeze({ name: 'Poppler pdfinfo', preservesSource: true, readOnly: true }),
        unsupported: Object.freeze(['outlines', 'optional-content-layers', 'structure-preserving-mutation']),
      });
    } catch (error) { throw mapEngineError(error); }
  }
  async listFonts(documentId, { signal } = {}) { return this.#runListing(documentId, 'listFonts', parseFonts, 2 * 1024 * 1024, signal); }
  async listImages(documentId, { signal } = {}) { return this.#runListing(documentId, 'listImages', parseImages, 4 * 1024 * 1024, signal); }
  async listAttachments(documentId, { signal } = {}) { return this.#runListing(documentId, 'listAttachments', parseAttachments, 2 * 1024 * 1024, signal); }
  async #runListing(documentId, operation, parser, limit, signal) {
    const document = this.#store.getDocument(documentId);
    await this.#store.verifySource(documentId);
    const input = this.#store.getSourcePath(documentId);
    try {
      const result = await this.#adapter.execute(operation, { input }, {
        signal, timeoutMs: 20_000, maxStdoutBytes: limit, maxStderrBytes: 256 * 1024,
      });
      const inventory = parser(result.stdout);
      await this.#store.verifySource(documentId);
      return Object.freeze(inventory.map((entry) => Object.freeze({ ...entry, sourceSha256: document.sha256 })));
    } catch (error) { throw mapEngineError(error); }
  }
}
