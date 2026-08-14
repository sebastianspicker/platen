import { HostError } from './host-error.mjs';

export const PDFKIT_TOP_LEVEL_OUTLINE_SPLIT_PROFILE = 'macos-pdfkit-top-level-outline-split-v1';
export const MAX_OUTLINE_SPLIT_OUTPUT_BYTES = 512 * 1024 * 1024;

function unsupported() {
  return new HostError(
    'OUTLINE_SPLIT_UNSUPPORTED',
    'This PDF does not have a complete supported top-level bookmark split.',
    422,
  );
}

function rootStarts(outline, pageCount) {
  if (!outline || outline.truncated !== false || !Array.isArray(outline.items)
    || outline.items.length < 2 || outline.items.length > 100) throw unsupported();
  if (outline.items.some((item) => typeof item?.title !== 'string'
    || item.title.length === 0 || Buffer.byteLength(item.title, 'utf8') > 1_024)) throw unsupported();
  const starts = outline.items.map((item) => item?.page);
  if (starts.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)
    || starts[0] !== 1
    || starts.some((page, index) => index > 0 && page <= starts[index - 1])) throw unsupported();
  return starts;
}

function cancelled(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'The verified bookmark split was cancelled.', 499);
}

export class PdfKitOutlineSplitService {
  #store; #pdf; #pdfkit;

  constructor({ store, pdfService, pdfkitInspectionService } = {}) {
    if (!store || !['getDocument', 'verifySource', 'deleteArtifact'].every((name) => typeof store[name] === 'function')) {
      throw new TypeError('PdfKitOutlineSplitService requires a DocumentStore-compatible store.');
    }
    if (!pdfService || typeof pdfService.extractPages !== 'function') {
      throw new TypeError('PdfKitOutlineSplitService requires PDF page extraction.');
    }
    if (!pdfkitInspectionService || typeof pdfkitInspectionService.inspect !== 'function') {
      throw new TypeError('PdfKitOutlineSplitService requires PDFKit inspection.');
    }
    this.#store = store;
    this.#pdf = pdfService;
    this.#pdfkit = pdfkitInspectionService;
  }

  async split(documentId, { signal } = {}) {
    const source = this.#store.getDocument(documentId);
    const inspection = await this.#pdfkit.inspect(documentId, { signal });
    if (inspection?.sourceDigest !== source.sha256
      || !Number.isSafeInteger(inspection?.pageCount)
      || inspection.pageCount < 2 || inspection.pageCount > 100
      || inspection.document?.pageCount !== inspection.pageCount) throw unsupported();
    const starts = rootStarts(inspection.outline, inspection.pageCount);
    const artifacts = [];
    let aggregateOutputBytes = 0;
    try {
      for (const [index, firstPage] of starts.entries()) {
        cancelled(signal);
        const lastPage = index + 1 < starts.length ? starts[index + 1] - 1 : inspection.pageCount;
        const pages = Array.from({ length: lastPage - firstPage + 1 }, (_, offset) => firstPage + offset);
        const artifact = await this.#pdf.extractPages(documentId, pages, {
          operationType: 'split-top-level-outline',
          fileLabel: `outline-${String(index + 1).padStart(3, '0')}-pages-${firstPage}-${lastPage}`,
          parameters: {
            splitRule: {
              kind: 'top-level-outline', profile: PDFKIT_TOP_LEVEL_OUTLINE_SPLIT_PROFILE,
              outputIndex: index + 1, outputCount: starts.length, firstPage, lastPage,
            },
          },
          signal,
        });
        if (!artifact || typeof artifact.id !== 'string') {
          throw new HostError('OUTLINE_SPLIT_ARTIFACT_INVALID', 'A split output did not have bounded artifact metadata.', 502);
        }
        artifacts.push(artifact);
        if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
          throw new HostError('OUTLINE_SPLIT_ARTIFACT_INVALID', 'A split output did not have bounded artifact metadata.', 502);
        }
        aggregateOutputBytes += artifact.size;
        if (!Number.isSafeInteger(aggregateOutputBytes) || aggregateOutputBytes > MAX_OUTLINE_SPLIT_OUTPUT_BYTES) {
          throw new HostError(
            'OUTLINE_SPLIT_OUTPUT_LIMIT',
            'Verified bookmark split outputs exceed the 512 MiB aggregate artifact limit.',
            413,
          );
        }
        cancelled(signal);
      }
      await this.#store.verifySource(documentId);
      cancelled(signal);
      return Object.freeze(artifacts);
    } catch (error) {
      const cleanup = await Promise.allSettled(artifacts.map((artifact) => this.#store.deleteArtifact(artifact.id)));
      if (cleanup.some((result) => result.status === 'rejected')) {
        throw new HostError(
          'OUTLINE_SPLIT_ROLLBACK_FAILED',
          'A failed bookmark split could not remove every partial artifact.',
          500,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
