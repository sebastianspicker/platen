import { PdfCompositionExecutor } from './pdf-composition-executor.mjs';
import { PdfCompositionValidation } from './pdf-composition-validation.mjs';
import { PdfOneDocumentComposition } from './pdf-one-document-composition.mjs';
import { PdfTwoDocumentComposition } from './pdf-two-document-composition.mjs';

export class PdfCompositionService {
  #executor; #oneDocument; #twoDocument;

  constructor({ store, adapter, inspection }) {
    const validation = new PdfCompositionValidation({ store, adapter, inspection });
    this.#executor = new PdfCompositionExecutor({ store, adapter, validation });
    this.#oneDocument = new PdfOneDocumentComposition({ inspection, executor: this.#executor });
    this.#twoDocument = new PdfTwoDocumentComposition({ inspection, executor: this.#executor });
  }

  composePages(...args) { return this.#executor.composePages(...args); }
  extractPages(...args) { return this.#oneDocument.extractPages(...args); }
  arrangePages(...args) { return this.#oneDocument.arrangePages(...args); }
  splitDocument(...args) { return this.#oneDocument.splitDocument(...args); }
  splitByPageCount(...args) { return this.#oneDocument.splitByPageCount(...args); }
  duplicatePages(...args) { return this.#oneDocument.duplicatePages(...args); }
  reversePages(...args) { return this.#oneDocument.reversePages(...args); }
  mergeDocuments(...args) { return this.#twoDocument.mergeDocuments(...args); }
  interleaveDocuments(...args) { return this.#twoDocument.interleaveDocuments(...args); }
  insertDocument(...args) { return this.#twoDocument.insertDocument(...args); }
  replacePages(...args) { return this.#twoDocument.replacePages(...args); }
  copyPageBetweenDocuments(...args) { return this.#twoDocument.copyPageBetweenDocuments(...args); }
}
