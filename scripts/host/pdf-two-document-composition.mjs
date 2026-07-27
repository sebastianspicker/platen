import { HostError } from './host-error.mjs';

export class PdfTwoDocumentComposition {
  #inspection; #executor;

  constructor({ inspection, executor }) { this.#inspection = inspection; this.#executor = executor; }

  mergeDocuments(...args) { return this.#executor.mergeDocuments(...args); }

  async interleaveDocuments(primaryDocumentId, secondaryDocumentId, { signal } = {}) {
    this.#assertDistinct(primaryDocumentId, secondaryDocumentId, 'INVALID_INTERLEAVE', 'Choose a different PDF to interleave.');
    const [primary, secondary] = await Promise.all([this.#inspection.inspect(primaryDocumentId, { signal }), this.#inspection.inspect(secondaryDocumentId, { signal })]);
    const selections = [];
    for (let index = 1; index <= Math.max(primary.pageCount, secondary.pageCount); index += 1) {
      if (index <= primary.pageCount) selections.push({ documentId: primaryDocumentId, page: index });
      if (index <= secondary.pageCount) selections.push({ documentId: secondaryDocumentId, page: index });
    }
    return this.#executor.composePages(primaryDocumentId, selections, { operationType: 'interleave-documents', fileLabel: 'interleaved', signal });
  }

  async insertDocument(primaryDocumentId, secondaryDocumentId, afterPage, { operationType = 'insert-pages', fileLabel = 'inserted', signal } = {}) {
    this.#assertDistinct(primaryDocumentId, secondaryDocumentId, 'INVALID_INSERT', 'Choose a different PDF to insert.');
    const [primary, secondary] = await Promise.all([this.#inspection.inspect(primaryDocumentId, { signal }), this.#inspection.inspect(secondaryDocumentId, { signal })]);
    if (!Number.isSafeInteger(afterPage) || afterPage < 0 || afterPage > primary.pageCount) throw new HostError('INVALID_INSERT', `afterPage must be from 0 through ${primary.pageCount}.`, 400);
    const selections = [];
    for (let page = 1; page <= afterPage; page += 1) selections.push({ documentId: primaryDocumentId, page });
    for (let page = 1; page <= secondary.pageCount; page += 1) selections.push({ documentId: secondaryDocumentId, page });
    for (let page = afterPage + 1; page <= primary.pageCount; page += 1) selections.push({ documentId: primaryDocumentId, page });
    return this.#executor.composePages(primaryDocumentId, selections, { operationType, fileLabel, signal });
  }

  async replacePages(primaryDocumentId, secondaryDocumentId, startPage, endPage, { signal } = {}) {
    this.#assertDistinct(primaryDocumentId, secondaryDocumentId, 'INVALID_REPLACE', 'Choose a different replacement PDF.');
    const [primary, secondary] = await Promise.all([this.#inspection.inspect(primaryDocumentId, { signal }), this.#inspection.inspect(secondaryDocumentId, { signal })]);
    if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage) || startPage < 1 || endPage < startPage || endPage > primary.pageCount) throw new HostError('INVALID_REPLACE', `Choose a replacement range within pages 1 through ${primary.pageCount}.`, 400);
    const selections = [];
    for (let page = 1; page < startPage; page += 1) selections.push({ documentId: primaryDocumentId, page });
    for (let page = 1; page <= secondary.pageCount; page += 1) selections.push({ documentId: secondaryDocumentId, page });
    for (let page = endPage + 1; page <= primary.pageCount; page += 1) selections.push({ documentId: primaryDocumentId, page });
    return this.#executor.composePages(primaryDocumentId, selections, { operationType: 'replace-pages', fileLabel: 'replaced', signal });
  }

  copyPageBetweenDocuments(...args) { return this.#executor.copyPageBetweenDocuments(...args); }

  #assertDistinct(primaryDocumentId, secondaryDocumentId, code, message) {
    if (primaryDocumentId === secondaryDocumentId) throw new HostError(code, message, 400);
  }
}
