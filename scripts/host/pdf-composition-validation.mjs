import { parsePdfInfo, parseAttachments, parseDocumentUrls, parseXmpMetadata, executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { mapEngineError } from './pdf-service-foundation.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRegularOutput, validatePngOutput, parsePageBoxes, parseTextPages } from './pdf-service-foundation.mjs';
import { inspectPassiveCopyGraphFile } from './pdf-copy-page-passive-graph.mjs';

const MAX_RENDER_BYTES = 32 * 1024 * 1024;
const silent = (result) => { if (String(result?.stderr ?? '').trim()) throw new HostError('POPPLER_WARNING', 'Poppler reported a warning while validating copied pages.', 422); };

export class PdfCompositionValidation {
  #store; #adapter; #inspection;

  constructor({ store, adapter, inspection }) {
    this.#store = store;
    this.#adapter = adapter;
    this.#inspection = inspection;
  }

  async inspectSources(sourceIds, { signal }) {
    return new Map(await Promise.all(sourceIds.map(async (documentId) => [
      documentId,
      await this.#inspection.inspect(documentId, { signal }),
    ])));
  }

  async verifySources(sourceIds) {
    await Promise.all(sourceIds.map((documentId) => this.#store.verifySource(documentId)));
  }

  validateSelections(selections, inspections) {
    for (const [index, selection] of selections.entries()) {
      const pageCount = inspections.get(selection.documentId).pageCount;
      if (selection.page > pageCount) {
        throw new HostError(
          'INVALID_PAGE_SELECTIONS',
          `Selection ${index + 1} requests page ${selection.page}, but its source has ${pageCount} pages.`,
          400,
        );
      }
    }
  }

  async validateDerivedPdf(filePath, { expectedPageCount, signal } = {}) {
    try {
      const inspectionResult = await this.#adapter.execute('inspect', { input: filePath }, {
        signal,
        timeoutMs: 20_000,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 128 * 1024,
      });
      const inspection = parsePdfInfo(inspectionResult.stdout);
      if (inspection.pageCount !== expectedPageCount) {
        throw new HostError(
          'DERIVED_PAGE_COUNT_MISMATCH',
          `The derived PDF has ${inspection.pageCount} pages; ${expectedPageCount} were expected.`,
          502,
        );
      }
      return inspection;
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async digestOutput(filePath) {
    return digestFile(filePath);
  }

  async semanticManifest(filePath, pageCount, workspace, { signal, prefix }) {
    try {
      const options = { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 128 * 1024 };
      const [boxesResult, textResult] = await Promise.all([
        this.#adapter.execute('inspectPageBoxes', { input: filePath, firstPage: 1, lastPage: pageCount }, options),
        this.#adapter.execute('extractText', { input: filePath, layout: true }, options),
      ]);
      silent(boxesResult); silent(textResult);
      const boxes = parsePageBoxes(boxesResult.stdout, { firstPage: 1, lastPage: pageCount });
      const text = parseTextPages(textResult.stdout, pageCount);
      const pages = [];
      for (let page = 1; page <= pageCount; page += 1) {
        const outputPrefix = join(workspace, `${prefix}-${page}`);
        const rendered = await this.#adapter.execute('renderPagePng', { input: filePath, outputPrefix, page, maxDimension: 256 }, options);
        silent(rendered);
        const png = `${outputPrefix}.png`;
        await validatePngOutput(png, MAX_RENDER_BYTES, 'Copy-page validation render');
        const pngBytes = await readRegularOutput(png, { minimumBytes: 8, maximumBytes: MAX_RENDER_BYTES, label: 'Copy-page validation render' });
        const { page: _page, ...pageBoxes } = boxes[page - 1];
        pages.push(Object.freeze({ boxes: Object.freeze(pageBoxes), textSha256: createHash('sha256').update(text[page - 1].text.normalize('NFC')).digest('hex'), renderSha256: createHash('sha256').update(pngBytes).digest('hex') }));
      }
      const digest = createHash('sha256').update(JSON.stringify(pages)).digest('hex');
      return Object.freeze({ pages: Object.freeze(pages), sha256: digest });
    } catch (error) { throw mapEngineError(error); }
  }

  async assertPassiveCopySource(filePath, inspection, workspace, { signal }) {
    const options = { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 128 * 1024 };
    const [xmp, attachments, urls, signatures, passiveGraph] = await Promise.all([
      this.#adapter.execute('inspectMetadata', { input: filePath }, options),
      this.#adapter.execute('listAttachments', { input: filePath }, options),
      this.#adapter.execute('inspectUrls', { input: filePath }, options),
      executeOfflineSignatureInspection(this.#adapter, { input: filePath, nssDirectory: workspace, signal }),
      inspectPassiveCopyGraphFile(filePath, {
        expectedPageCount: inspection.pageCount,
        signal,
      }),
    ]);
    silent(xmp); silent(attachments); silent(urls);
    if (String(inspection.encrypted).toLowerCase() !== 'no' || String(inspection.form).toLowerCase() !== 'none'
      || String(inspection.javascript).toLowerCase() !== 'no' || String(inspection.tagged).toLowerCase() !== 'no'
      || parseXmpMetadata(xmp.stdout).present || parseAttachments(attachments.stdout).length !== 0
      || parseDocumentUrls(urls.stdout).length !== 0 || signatures.status !== 'unsigned' || signatures.signatureCount !== 0) {
      throw new HostError('COPY_PAGE_SOURCE_UNSUPPORTED', 'Copy-page requires an unsigned, unencrypted, untagged PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
    }
    if (passiveGraph.schema !== 'pdf-copy-page-passive-graph-v1'
      || passiveGraph.version !== 1
      || passiveGraph.pageCount !== inspection.pageCount
      || passiveGraph.outlinesPresent !== false
      || passiveGraph.optionalContentPresent !== false
      || passiveGraph.annotationCount !== 0
      || passiveGraph.actionCount !== 0) {
      throw new HostError('COPY_PAGE_SOURCE_UNSUPPORTED', 'Copy-page passive graph inspection failed.', 422);
    }
  }
}
