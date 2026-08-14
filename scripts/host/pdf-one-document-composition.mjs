import { MAX_COMPOSE_PAGES, MAX_SPLIT_OUTPUTS, validatePages } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';

export class PdfOneDocumentComposition {
  #inspection; #executor;

  constructor({ inspection, executor }) { this.#inspection = inspection; this.#executor = executor; }

  async #atomicOutputs(createOutput, outputCount, signal) {
    const artifacts = [];
    try {
      for (let index = 0; index < outputCount; index += 1) {
        if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'The split operation was cancelled.', 499);
        const artifact = await createOutput(index);
        if (!artifact || typeof artifact.id !== 'string' || artifact.id.length < 1) {
          throw new HostError('COMPOSITION_OUTPUT_INVALID', 'Split returned an invalid retained-artifact receipt.', 502);
        }
        artifacts.push(artifact);
        if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'The split operation was cancelled.', 499);
      }
      return Object.freeze(artifacts);
    } catch (error) {
      const rollback = await Promise.allSettled(artifacts.map(({ id }) => this.#executor.deleteArtifact(id)));
      const failures = rollback.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
      if (failures.length) {
        throw new HostError('SPLIT_ROLLBACK_FAILED', 'Split could not revoke every earlier output after incomplete execution.', 500, {
          cause: new AggregateError([error, ...failures]),
        });
      }
      throw error;
    }
  }

  async extractPages(documentId, pages, { operationType = 'extract-pages', fileLabel = null, parameters = {}, signal } = {}) {
    const inspection = await this.#inspection.inspect(documentId, { signal });
    const selected = validatePages(pages, inspection.pageCount);
    return this.#executor.composePages(documentId, selected.map((page) => ({ documentId, page })), {
      operationType, fileLabel: fileLabel ?? `pages-${selected.join('-')}`, parameters, signal,
    });
  }

  async arrangePages(documentId, pages, { signal } = {}) {
    const inspection = await this.#inspection.inspect(documentId, { signal });
    const selected = validatePages(pages, inspection.pageCount);
    if (new Set(selected).size !== selected.length) throw new HostError('INVALID_PAGES', 'An arranged document cannot contain a source page more than once.', 400);
    return this.extractPages(documentId, selected, { operationType: 'arrange-pages', fileLabel: 'arranged', signal });
  }

  async splitDocument(documentId, { signal } = {}) {
    const inspection = await this.#inspection.inspect(documentId, { signal });
    if (inspection.pageCount > MAX_SPLIT_OUTPUTS) throw new HostError('SPLIT_OUTPUT_LIMIT', `Split-to-individual-files is limited to ${MAX_SPLIT_OUTPUTS} output PDFs per operation.`, 422);
    return this.#atomicOutputs((index) => {
      const page = index + 1;
      return this.extractPages(documentId, [page], { operationType: 'split-document', fileLabel: `page-${page}`, signal });
    }, inspection.pageCount, signal);
  }

  async splitByPageCount(documentId, pagesPerOutput, { signal } = {}) {
    if (!Number.isSafeInteger(pagesPerOutput) || pagesPerOutput < 1 || pagesPerOutput > MAX_COMPOSE_PAGES) throw new HostError('INVALID_SPLIT_RULE', `pagesPerOutput must be an integer from 1 through ${MAX_COMPOSE_PAGES}.`, 400);
    const inspection = await this.#inspection.inspect(documentId, { signal });
    const outputCount = Math.ceil(inspection.pageCount / pagesPerOutput);
    if (outputCount > MAX_SPLIT_OUTPUTS) throw new HostError('SPLIT_OUTPUT_LIMIT', `This rule would create ${outputCount} PDFs; at most ${MAX_SPLIT_OUTPUTS} outputs are allowed.`, 422);
    return this.#atomicOutputs((outputIndex) => {
      const firstPage = outputIndex * pagesPerOutput + 1;
      const lastPage = Math.min(inspection.pageCount, firstPage + pagesPerOutput - 1);
      const pages = Array.from({ length: lastPage - firstPage + 1 }, (_, index) => firstPage + index);
      return this.extractPages(documentId, pages, {
        operationType: 'split-by-page-count', fileLabel: `pages-${firstPage}-${lastPage}`,
        parameters: { splitRule: { kind: 'every-pages', pagesPerOutput, outputIndex: outputIndex + 1, outputCount } }, signal,
      });
    }, outputCount, signal);
  }

  async duplicatePages(documentId, pages, { signal } = {}) {
    const inspection = await this.#inspection.inspect(documentId, { signal });
    const selected = validatePages(pages, inspection.pageCount);
    if (new Set(selected).size !== selected.length) throw new HostError('INVALID_PAGES', 'Choose each page to duplicate at most once.', 400);
    const duplicate = new Set(selected);
    const order = [];
    for (let page = 1; page <= inspection.pageCount; page += 1) { order.push(page); if (duplicate.has(page)) order.push(page); }
    return this.#executor.composePages(documentId, order.map((page) => ({ documentId, page })), { operationType: 'duplicate-pages', fileLabel: 'duplicated', signal });
  }

  async reversePages(documentId, { signal } = {}) {
    const inspection = await this.#inspection.inspect(documentId, { signal });
    if (inspection.pageCount > MAX_COMPOSE_PAGES) throw new HostError('COMPOSE_PAGE_LIMIT', `Reverse is limited to ${MAX_COMPOSE_PAGES} pages.`, 422);
    const pages = Array.from({ length: inspection.pageCount }, (_, index) => inspection.pageCount - index);
    return this.#executor.composePages(documentId, pages.map((page) => ({ documentId, page })), { operationType: 'reverse-pages', fileLabel: 'reversed', signal });
  }
}
