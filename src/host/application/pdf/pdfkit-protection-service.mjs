import { protectPdfKitDocument } from './pdfkit-protection-operation.mjs';
import { removePdfKitProtection } from './pdfkit-protection-removal-operation.mjs';

export { PDFKIT_PROTECTION_PROFILE, PDFKIT_PROTECTION_REMOVAL_PROFILE } from './pdfkit-protection-contract.mjs';

/** Compatibility facade for the two fixed PDFKit protection operations. */
export class PdfKitProtectionService {
  #dependencies;

  constructor({ store, pdfService, poppler, adapter } = {}) {
    if (!store || !['getDocument', 'getArtifact', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact']
      .every((name) => typeof store[name] === 'function')) {
      throw new TypeError('PdfKitProtectionService requires a DocumentStore-compatible store.');
    }
    if (!pdfService || !['inspect', 'inspectStructure', 'listAttachments', 'verifySignatures']
      .every((name) => typeof pdfService[name] === 'function')) {
      throw new TypeError('PdfKitProtectionService requires PDF inspection services.');
    }
    if (!poppler || typeof poppler.execute !== 'function') {
      throw new TypeError('PdfKitProtectionService requires a Poppler adapter.');
    }
    if (!adapter || !['protect', 'removeProtection'].every((name) => typeof adapter[name] === 'function')) {
      throw new TypeError('PdfKitProtectionService requires a PDFKit protection adapter.');
    }
    this.#dependencies = Object.freeze({ store, pdfService, poppler, adapter });
  }

  protect(documentId, protectionInput, options) {
    return protectPdfKitDocument(this.#dependencies, documentId, protectionInput, options);
  }

  removeProtection(documentId, removalInput, options) {
    return removePdfKitProtection(this.#dependencies, documentId, removalInput, options);
  }
}
