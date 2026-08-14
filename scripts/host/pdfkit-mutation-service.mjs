import { HostError } from './host-error.mjs';
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

async function cleanupPdfKitMutation(store, lifecycle) {
  let cleanupError = null;
  if (lifecycle.workspace) {
    try { await store.cleanupJob(lifecycle.workspace); } catch (error) { cleanupError = error; }
  }
  let revocationError = null;
  if (lifecycle.promotedArtifact && (!lifecycle.completed || cleanupError)) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { revocationError = error; }
  }
  if (cleanupError || revocationError) {
    throw new HostError(
      'PDFKIT_MUTATION_CLEANUP_FAILED',
      'PDFKit mutation could not clean its private workspace or retained artifact.',
      500,
      { cause: new AggregateError(
        [lifecycle.primaryError, cleanupError, revocationError].filter(Boolean),
        'PDFKit mutation cleanup failed.',
      ) },
    );
  }
}

export class PdfKitMutationService {
  #store;
  #poppler;
  #adapter;
  #limits;

  constructor({ store, poppler, adapter, limits } = {}) {
    const storeMethods = [
      'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob',
      'promotePdfArtifact', 'deleteArtifact',
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
    const lifecycle = {
      workspace: null, promotedArtifact: null, completed: false, primaryError: null,
    };
    try {
      await this.#store.verifySource(documentId);
      const storedSourcePath = this.#store.getSourcePath(documentId);
      lifecycle.workspace = await this.#store.createJobWorkspace(documentId);
      const staged = await stagePdfKitMutationSource({
        store: this.#store, poppler: this.#poppler, documentId, workspace: lifecycle.workspace, job,
        limits: this.#limits, source: admission.source, storedSourcePath,
      });
      const validatedRequest = await validatePdfKitMutationOperation({
        poppler: this.#poppler, workspace: lifecycle.workspace, job, limits: this.#limits,
        source: admission.source, profile: admission.profile, mutationInput, ...staged,
      });
      const executed = await executePdfKitMutationOperation({
        adapter: this.#adapter, workspace: lifecycle.workspace, job, limits: this.#limits,
        source: admission.source, ...staged, ...validatedRequest,
      });
      const verified = await verifyPdfKitMutationOperation({
        poppler: this.#poppler, store: this.#store, documentId, workspace: lifecycle.workspace, job,
        limits: this.#limits, source: admission.source, ...staged, ...validatedRequest, ...executed,
      });
      const promoted = await promotePdfKitMutationOperation({
        store: this.#store, documentId, source: admission.source, job,
        ...staged, ...validatedRequest, ...executed, ...verified,
      });
      lifecycle.promotedArtifact = promoted.artifact;
      if (job.signal.aborted) throw job.signal.reason ?? new Error('PDFKit mutation was cancelled after promotion.');
      lifecycle.completed = true;
      return promoted;
    } catch (error) {
      lifecycle.primaryError = translatePdfKitMutationError(error, { job, externalSignal });
      throw lifecycle.primaryError;
    } finally {
      job.dispose();
      await cleanupPdfKitMutation(this.#store, lifecycle);
    }
  }
}
