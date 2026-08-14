export * from './pdf-service-foundation.mjs';
export * from './pdf-compact-rewrite.mjs';
export * from './pdf-tagged-remediation-writer.mjs';
export * from './pdf-acroform.mjs';

import { PdfInspectionService } from './pdf-inspection-service.mjs';
import { PdfCompositionService } from './pdf-composition-service.mjs';
import { PdfOcrService } from './pdf-ocr-service.mjs';

export class PdfService {
  #inspection; #composition; #ocr;
  constructor({
    store, registry, adapter, ocrAdapter = null, ocrImageAdapter = null,
    signatureTrustAdapter = null,
  }) {
    if (!store || !registry || !adapter) throw new TypeError('PdfService requires store, registry, and adapter.');
    this.#inspection = new PdfInspectionService({ store, registry, adapter, signatureTrustAdapter });
    this.#composition = new PdfCompositionService({ store, adapter, inspection: this.#inspection });
    this.#ocr = new PdfOcrService({ store, adapter, ocrAdapter, ocrImageAdapter, inspection: this.#inspection });
  }
  availability(...args) { return this.#inspection.availability(...args); }
  inspect(...args) { return this.#inspection.inspect(...args); }
  inspectPage(...args) { return this.#inspection.inspectPage(...args); }
  inspectStructure(...args) { return this.#inspection.inspectStructure(...args); }
  extractText(...args) { return this.#inspection.extractText(...args); }
  renderThumbnail(...args) { return this.#inspection.renderThumbnail(...args); }
  renderOverlayPageExactDpi(...args) { return this.#inspection.renderOverlayPageExactDpi(...args); }
  renderCropBoxPage(...args) { return this.#inspection.renderCropBoxPage(...args); }
  renderCropBoxSnapshot(...args) { return this.#inspection.renderCropBoxSnapshot(...args); }
  listFonts(...args) { return this.#inspection.listFonts(...args); }
  listImages(...args) { return this.#inspection.listImages(...args); }
  listAttachments(...args) { return this.#inspection.listAttachments(...args); }
  verifySignatures(...args) { return this.#inspection.verifySignatures(...args); }
  composePages(...args) { return this.#composition.composePages(...args); }
  extractPages(...args) { return this.#composition.extractPages(...args); }
  arrangePages(...args) { return this.#composition.arrangePages(...args); }
  splitDocument(...args) { return this.#composition.splitDocument(...args); }
  splitByPageCount(...args) { return this.#composition.splitByPageCount(...args); }
  insertDocument(...args) { return this.#composition.insertDocument(...args); }
  duplicatePages(...args) { return this.#composition.duplicatePages(...args); }
  reversePages(...args) { return this.#composition.reversePages(...args); }
  interleaveDocuments(...args) { return this.#composition.interleaveDocuments(...args); }
  replacePages(...args) { return this.#composition.replacePages(...args); }
  mergeDocuments(...args) { return this.#composition.mergeDocuments(...args); }
  copyPageBetweenDocuments(...args) { return this.#composition.copyPageBetweenDocuments(...args); }
  ocrLanguages(...args) { return this.#ocr.ocrLanguages(...args); }
  ocrDocument(...args) { return this.#ocr.ocrDocument(...args); }
  ocrBatchDocuments(...args) { return this.#ocr.ocrBatchDocuments(...args); }
  analyzeOcrLayout(...args) { return this.#ocr.analyzeOcrLayout(...args); }
}
