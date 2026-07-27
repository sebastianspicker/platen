import { createBlankDocument, createTextDocument } from './conversion-document-factory.mjs';
import { prepareBlankDocumentExport } from './conversion-blank-export.mjs';
import { preparePngPdfDocumentExport } from './conversion-png-export.mjs';
import { convertInputAsset } from './conversion-input.mjs';
import { rewritePdfDocument } from './conversion-rewrite.mjs';

export { assertInlineOnlyHtml } from './conversion-admission.mjs';
export { mapConversionError } from './conversion-job-runtime.mjs';

export class ConversionService {
  #documents;
  #inputs;
  #poppler;
  #ghostscript;
  #libreOffice;
  #imageMagick;

  constructor({ documents, inputs, poppler, ghostscript, libreOffice, imageMagick }) {
    if (!documents || !inputs || !poppler || !ghostscript || !libreOffice || !imageMagick) {
      throw new TypeError(
        'ConversionService requires document/input stores and four local engine adapters.',
      );
    }
    this.#documents = documents;
    this.#inputs = inputs;
    this.#poppler = poppler;
    this.#ghostscript = ghostscript;
    this.#libreOffice = libreOffice;
    this.#imageMagick = imageMagick;
  }

  createBlank(options = {}) {
    return createBlankDocument(this.#documents, options);
  }

  prepareBlankExport(documentId, { pages, signal } = {}) {
    return prepareBlankDocumentExport({
      documents: this.#documents,
      poppler: this.#poppler,
      documentId,
      pages,
      externalSignal: signal,
    });
  }

  preparePngPdfExport(documentId, { signal } = {}) {
    return preparePngPdfDocumentExport({
      documents: this.#documents,
      poppler: this.#poppler,
      documentId,
      externalSignal: signal,
    });
  }

  createText(options = {}) {
    return createTextDocument(this.#documents, options);
  }

  convertInput(assetId, { signal } = {}) {
    return convertInputAsset({
      assetId,
      externalSignal: signal,
      inputs: this.#inputs,
      documents: this.#documents,
      poppler: this.#poppler,
      adapters: {
        ghostscript: this.#ghostscript,
        libreOffice: this.#libreOffice,
        imageMagick: this.#imageMagick,
      },
    });
  }

  rewriteDocument(documentId, mode, { signal } = {}) {
    return rewritePdfDocument({
      documentId,
      mode,
      externalSignal: signal,
      documents: this.#documents,
      poppler: this.#poppler,
      ghostscript: this.#ghostscript,
    });
  }
}
