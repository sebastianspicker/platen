import {
  cleanupReceipt,
  decodeUtf8,
  mapEngineError,
  MAX_OCR_BATCH_BYTES,
  MAX_OCR_PAGE_BYTES,
  MAX_OCR_PAGES,
  MAX_OCR_RASTER_BYTES,
  MAX_OCR_TSV_BYTES,
  ocrDpi,
  openRegularOutput,
  parsePdfInfo,
  parseTesseractTsv,
  pngDimensions,
  readRegularOutput,
  validateOcrMode,
  validatePngOutput,
} from './pdf-service-foundation.mjs';
import { basename, extname, join } from 'node:path';
import { rename, unlink } from 'node:fs/promises';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { normalizeOcrUserDictionary } from '../../src/core/ocr-contract.js';
import { createOcrUserDictionary, createSearchableOcrProvenance, ocrLanguages, validateOcrLanguage, withOcrWorkspace } from './ocr-job-helpers.mjs';

async function validateDerivedPdf(adapter, filePath, { expectedPageCount, requireExtractedText = false, signal } = {}) {
  try {
    const inspection = parsePdfInfo((await adapter.execute('inspect', { input: filePath }, {
      signal, timeoutMs: 20_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024,
    })).stdout);
    if (inspection.pageCount !== expectedPageCount) throw new HostError('DERIVED_PAGE_COUNT_MISMATCH', `The derived PDF has ${inspection.pageCount} pages; ${expectedPageCount} were expected.`, 502);
    if (requireExtractedText) {
      const text = await adapter.execute('extractText', { input: filePath, layout: false }, {
        signal, timeoutMs: 45_000, maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 128 * 1024,
      });
      if (!text.stdout.trim()) throw new HostError('OCR_TEXT_LAYER_MISSING', 'The OCR PDF did not retain its recognized text layer.', 502);
    }
    return inspection;
  } catch (error) { throw mapEngineError(error); }
}

export class OcrDocumentPipeline {
  #store; #adapter; #ocrAdapter; #ocrImageAdapter; #inspection;
  constructor({ store, adapter, ocrAdapter, ocrImageAdapter, inspection }) { this.#store = store; this.#adapter = adapter; this.#ocrAdapter = ocrAdapter; this.#ocrImageAdapter = ocrImageAdapter; this.#inspection = inspection; }

  async run(documentId, { language = 'eng', cleanupPreset = 'none', segmentation = 'auto', userDictionary = [], maximumOutputBytes = MAX_OCR_BATCH_BYTES, signal: externalSignal } = {}) {
    if (!this.#ocrAdapter) throw new HostError('ENGINE_UNAVAILABLE', 'The local OCR engine is unavailable.', 503);
    validateOcrMode(cleanupPreset, segmentation);
    const normalizedUserDictionary = normalizeOcrUserDictionary(userDictionary);
    if (cleanupPreset !== 'none' && !this.#ocrImageAdapter) throw new HostError('ENGINE_UNAVAILABLE', 'The local OCR cleanup engine is unavailable.', 503);
    return withOcrWorkspace({
      store: this.#store, documentId, externalSignal,
      timeoutMessage: 'Local OCR exceeded its ten-minute job deadline.',
      cancelledMessage: 'The local OCR operation was cancelled.',
      work: async ({ deadline, createWorkspace }) => {
        const languages = await ocrLanguages(this.#ocrAdapter, { signal: deadline.signal });
        validateOcrLanguage(language, languages);
        const inspection = await this.#inspection.inspect(documentId, { signal: deadline.signal });
        if (inspection.pageCount > MAX_OCR_PAGES) throw new HostError('OCR_PAGE_LIMIT', `OCR is limited to ${MAX_OCR_PAGES} pages per derived document.`, 422);
        const input = this.#store.getSourcePath(documentId);
        const source = this.#store.getDocument(documentId);
        await this.#store.verifySource(documentId);
        const { workspace, quota } = await createWorkspace();
        const dictionary = await createOcrUserDictionary(workspace, normalizedUserDictionary);
        const pagePdfs = []; const suspects = []; const cleanupReceipts = []; let recognizedWordCount = 0;
        for (let page = 1; page <= inspection.pageCount; page += 1) {
          const pageGeometry = await this.#inspection.inspectPage(documentId, page, { signal: deadline.signal });
          const imagePrefix = join(workspace, `source-${page}`); const imagePath = `${imagePrefix}.png`; const outputBase = join(workspace, `ocr-${page}`);
          await this.#adapter.execute('renderPagePng', { input, outputPrefix: imagePrefix, page, maxDimension: 3_200 }, { cwd: workspace, signal: deadline.signal, timeoutMs: 45_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 });
          await validatePngOutput(imagePath, MAX_OCR_RASTER_BYTES, `Poppler OCR page ${page}`);
          const dimensions = await pngDimensions(imagePath); const beforeCleanup = Object.freeze({ ...dimensions, sha256: await digestFile(imagePath) }); const dpi = ocrDpi(dimensions, pageGeometry);
          let afterCleanup = beforeCleanup;
          if (cleanupPreset !== 'none') {
            const cleanedPath = join(workspace, `clean-${page}.png`);
            await this.#ocrImageAdapter.execute('cleanup', { input: imagePath, output: cleanedPath, workspace, imageWidth: dimensions.width, imageHeight: dimensions.height, dpi, preset: cleanupPreset }, { cwd: workspace, signal: deadline.signal, timeoutMs: 45_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 });
            await validatePngOutput(cleanedPath, MAX_OCR_RASTER_BYTES, `OCR cleanup page ${page}`); const cleaned = await pngDimensions(cleanedPath);
            if (cleaned.width !== dimensions.width || cleaned.height !== dimensions.height) throw new HostError('INVALID_ENGINE_OUTPUT', 'OCR cleanup changed the raster canvas dimensions.', 502);
            await unlink(imagePath); await rename(cleanedPath, imagePath);
            afterCleanup = Object.freeze({ ...cleaned, sha256: await digestFile(imagePath) });
          }
          cleanupReceipts.push(cleanupReceipt(page, beforeCleanup, afterCleanup, cleanupPreset));
          await quota.check();
          await this.#ocrAdapter.execute('recognizePagePdf', { input: imagePath, outputBase, language, dpi, segmentation, ...(dictionary ? { userWordsPath: dictionary.path } : {}) }, { cwd: workspace, signal: deadline.signal, timeoutMs: 90_000, maxStdoutBytes: 256 * 1024, maxStderrBytes: 512 * 1024 });
          await unlink(imagePath).catch(() => {}); await quota.check();
          const pagePdf = `${outputBase}.pdf`; const pageOutput = await openRegularOutput(pagePdf, { maximumBytes: MAX_OCR_PAGE_BYTES, label: `OCR PDF page ${page}` }); await pageOutput.handle.close(); pagePdfs.push(pagePdf);
          const tsvPath = `${outputBase}.tsv`; const tsvBytes = await readRegularOutput(tsvPath, { maximumBytes: MAX_OCR_TSV_BYTES, label: `OCR TSV page ${page}` }); const words = parseTesseractTsv(decodeUtf8(tsvBytes, `OCR TSV page ${page}`), page);
          recognizedWordCount += words.length;
          for (const word of words) if (word.confidence < 60 && suspects.length < 500) suspects.push(word);
          await unlink(tsvPath).catch(() => {}); await quota.check();
        }
        if (recognizedWordCount === 0) throw new HostError('OCR_NO_TEXT', 'Tesseract did not recognize text, so no searchable PDF was promoted.', 422);
        const combinedPath = pagePdfs.length === 1 ? pagePdfs[0] : join(workspace, 'searchable-ocr.pdf');
        if (pagePdfs.length > 1) { await this.#adapter.execute('mergeDocuments', { inputs: pagePdfs, output: combinedPath }, { cwd: workspace, signal: deadline.signal, timeoutMs: 60_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 }); await quota.check(); }
        const derivedInspection = await validateDerivedPdf(this.#adapter, combinedPath, { expectedPageCount: inspection.pageCount, requireExtractedText: true, signal: deadline.signal });
        await Promise.all(pagePdfs.filter((filePath) => filePath !== combinedPath).map((filePath) => unlink(filePath).catch(() => {}))); await quota.check(); await this.#store.verifySource(documentId);
        const stem = basename(source.displayName, extname(source.displayName)); const boundedOutput = await openRegularOutput(combinedPath, { maximumBytes: maximumOutputBytes, label: 'Searchable OCR PDF' }); await boundedOutput.handle.close(); const expectedSha256 = await digestFile(combinedPath);
        const userDictionaryEvidence = Object.freeze({ termCount: dictionary?.termCount ?? 0, digest: dictionary?.digest ?? null });
        const artifact = await this.#store.promotePdfArtifact(documentId, combinedPath, { displayName: `${stem}-searchable-ocr.pdf`, expectedSha256, signal: deadline.signal, operation: createSearchableOcrProvenance({ documentId, sourceSha256: source.sha256, language, pageCount: inspection.pageCount, cleanupPreset, segmentation, userDictionary: userDictionaryEvidence, cleanupReceipts, derivedPageCount: derivedInspection.pageCount, recognizedWordCount, suspectCount: suspects.length }) });
        return Object.freeze({ kind: 'searchable-ocr-document', schemaVersion: 1, sourceDigest: source.sha256, artifact, result: Object.freeze({ language, pageCount: inspection.pageCount, recognizedWordCount, rasterized: true, cleanupPreset, segmentation, userDictionary: userDictionaryEvidence, suspects: Object.freeze(suspects) }), evidence: Object.freeze({ localOnly: true, sourceBound: true, rasterized: true, reviewRequired: true, engines: Object.freeze(cleanupPreset === 'none' ? ['Poppler', 'Tesseract'] : ['Poppler', 'ImageMagick', 'Tesseract']), cleanupReceipts: Object.freeze(cleanupReceipts) }), limitations: Object.freeze(['Searchable OCR is raster-derived and requires review against the immutable source PDF.']) });
      },
    });
  }
}
