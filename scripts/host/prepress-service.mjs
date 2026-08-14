
import { PrepressServiceCore } from './prepress/prepress-service-core.mjs';
import { DEFAULT_PREPRESS_LIMITS, parseInkCoverage } from './prepress/prepress-support.mjs';
import { createCmykConversionOperation } from './prepress/cmyk-conversion.mjs';
import { createImpositionOperation } from './prepress/imposition.mjs';
import { createPreflightInkOperations } from './prepress/preflight-ink.mjs';
import { createPreviewOperations } from './prepress/previews.mjs';
import { createProductionValidationOperation } from './prepress/production-validation.mjs';
import { PdfOutputIntentService } from './prepress/output-intent-service.mjs';
import { HostError } from './host-error.mjs';

export { DEFAULT_PREPRESS_LIMITS, parseInkCoverage };

/**
 * Compatibility facade for the host prepress contract.
 *
 * Cohesive operation modules keep callers on this stable API while the core
 * owns the single source/workspace/derived-artifact guard implementation.
 */
export class PrepressService {
  #preflightInk; #convertToCmyk; #createImposition; #previews; #runProductionValidation; #outputIntent;

  constructor(options = {}) {
    const core = new PrepressServiceCore(options);
    this.#preflightInk = createPreflightInkOperations(core);
    core.operations = this.#preflightInk;
    this.#convertToCmyk = createCmykConversionOperation(core);
    this.#createImposition = createImpositionOperation(core);
    this.#previews = createPreviewOperations(core);
    this.#runProductionValidation = createProductionValidationOperation(core);
    this.#outputIntent = core.profiles ? new PdfOutputIntentService({ core }) : null;
  }

  get outputIntentProfileReady() { return Boolean(this.#outputIntent); }

  analyzeInkCoverage(documentId, options) { return this.#preflightInk.analyzeInkCoverage(documentId, options); }
  runPreflight(documentId, options) { return this.#preflightInk.runPreflight(documentId, options); }
  convertToCmyk(documentId, options) { return this.#convertToCmyk(documentId, options); }
  createImposition(documentId, options) { return this.#createImposition(documentId, options); }
  runProductionValidation(documentId, options) { return this.#runProductionValidation(documentId, options); }
  renderSeparations(documentId, options) { return this.#previews.renderSeparations(documentId, options); }
  renderOverprintPreview(documentId, options) { return this.#previews.renderOverprintPreview(documentId, options); }
  assignOutputIntent(documentId, request, options) {
    if (!this.#outputIntent) {
      return Promise.reject(new HostError(
        'PREPRESS_ARTIFACT_UNAVAILABLE',
        'Validated OutputIntent assignment is unavailable.',
        503,
      ));
    }
    return this.#outputIntent.assign(documentId, request, options);
  }
}
