import { checkPdfKitMutationLimits, DEFAULT_PDFKIT_MUTATION_LIMITS } from './pdfkit-mutation-contract.mjs';
import { validatePdfKitMutationAdmission } from './pdfkit-mutation-operation-admission.mjs';
import { executePdfKitMutationOperation } from './pdfkit-mutation-operation-execution.mjs';
import { createPdfKitMutationJob, translatePdfKitMutationError } from './pdfkit-mutation-operation-lifecycle.mjs';
import { promotePdfKitMutationOperation } from './pdfkit-mutation-operation-promotion.mjs';
import { stagePdfKitMutationSource } from './pdfkit-mutation-operation-staging.mjs';
import { validatePdfKitMutationOperation } from './pdfkit-mutation-operation-validation.mjs';
import { verifyPdfKitMutationOperation } from './pdfkit-mutation-operation-verification.mjs';

export {
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
} from './pdfkit-mutation-contract.mjs';

export class PdfKitMutationService {
  #store;
  #poppler;
  #adapter;
  #limits;

  constructor({ store, poppler, adapter, limits } = {}) {
    const storeMethods = [
      'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob',
      'promotePdfArtifact',
    ];
    if (!store || !storeMethods.every((name) => typeof store[name] === 'function')) {
      throw new TypeError('PdfKitMutationService requires a DocumentStore-compatible store.');
    }
    if (!poppler || typeof poppler.execute !== 'function') {
      throw new TypeError('PdfKitMutationService requires a Poppler adapter.');
    }
    if (!adapter || typeof adapter.mutate !== 'function') {
      throw new TypeError('PdfKitMutationService requires a PDFKit mutation adapter.');
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#adapter = adapter;
    this.#limits = checkPdfKitMutationLimits(limits);
  }

  async mutate(documentId, mutationInput, {
    sourceSha256, signal: externalSignal, profile,
  } = {}) {
    const admission = validatePdfKitMutationAdmission({
      store: this.#store, documentId, sourceSha256, profile,
    });
    const job = createPdfKitMutationJob(externalSignal);
    let workspace = null;
    try {
      await this.#store.verifySource(documentId);
      const storedSourcePath = this.#store.getSourcePath(documentId);
      workspace = await this.#store.createJobWorkspace(documentId);
      const staged = await stagePdfKitMutationSource({
        store: this.#store, poppler: this.#poppler, documentId, workspace, job,
        limits: this.#limits, source: admission.source, storedSourcePath,
      });
      const validatedRequest = await validatePdfKitMutationOperation({
        poppler: this.#poppler, workspace, job, limits: this.#limits,
        source: admission.source, profile: admission.profile, mutationInput, ...staged,
      });
      const executed = await executePdfKitMutationOperation({
        adapter: this.#adapter, workspace, job, limits: this.#limits,
        source: admission.source, ...staged, ...validatedRequest,
      });
      const verified = await verifyPdfKitMutationOperation({
        poppler: this.#poppler, store: this.#store, documentId, workspace, job,
        limits: this.#limits, source: admission.source, ...staged, ...validatedRequest, ...executed,
      });
      return await promotePdfKitMutationOperation({
        store: this.#store, documentId, source: admission.source, job,
        ...staged, ...validatedRequest, ...executed, ...verified,
      });
    } catch (error) {
      throw translatePdfKitMutationError(error, { job, externalSignal });
    } finally {
      job.dispose();
      if (workspace) await this.#store.cleanupJob(workspace);
    }
  }
}
