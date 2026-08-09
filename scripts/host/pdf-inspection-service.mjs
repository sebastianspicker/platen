import { BUILTIN_EXECUTABLES } from './engine-registry.mjs';
import { OfflineSignatureService } from './offline-signature-service.mjs';
import { PdfInspectionBasic } from './pdf-inspection-basic.mjs';
import { PdfInspectionRaster } from './pdf-inspection-raster.mjs';
import { PdfInspectionResources } from './pdf-inspection-resources.mjs';

export class PdfInspectionService {
  #registry; #basic; #raster; #resources; #signatures;
  constructor({ store, registry, adapter, signatureTrustAdapter = null }) {
    this.#registry = registry;
    this.#basic = new PdfInspectionBasic({ store, adapter });
    this.#raster = new PdfInspectionRaster({
      store, adapter, inspectPage: this.#basic.inspectPage.bind(this.#basic),
    });
    this.#resources = new PdfInspectionResources({
      store, adapter, inspect: this.#basic.inspect.bind(this.#basic),
    });
    this.#signatures = new OfflineSignatureService({ store, poppler: adapter, trust: signatureTrustAdapter });
  }
  async availability() {
    const settled = await Promise.allSettled(BUILTIN_EXECUTABLES.map((name) => this.#registry.probe(name)));
    return Object.freeze(settled.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : Object.freeze({ name: BUILTIN_EXECUTABLES[index], available: false, reason: result.reason?.code ?? 'ENGINE_NOT_FOUND' })));
  }
  inspect(...args) { return this.#basic.inspect(...args); }
  inspectPage(...args) { return this.#basic.inspectPage(...args); }
  extractText(...args) { return this.#basic.extractText(...args); }
  inspectStructure(...args) { return this.#resources.inspectStructure(...args); }
  listFonts(...args) { return this.#resources.listFonts(...args); }
  listImages(...args) { return this.#resources.listImages(...args); }
  listAttachments(...args) { return this.#resources.listAttachments(...args); }
  renderThumbnail(...args) { return this.#raster.renderThumbnail(...args); }
  renderOverlayPageExactDpi(...args) { return this.#raster.renderOverlayPageExactDpi(...args); }
  renderCropBoxPage(...args) { return this.#raster.renderCropBoxPage(...args); }
  renderCropBoxSnapshot(...args) { return this.#raster.renderCropBoxSnapshot(...args); }
  verifySignatures(documentId, { signal } = {}) { return this.#signatures.verify(documentId, { signal }); }
}
