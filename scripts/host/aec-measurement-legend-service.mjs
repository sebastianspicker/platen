import { createAecMeasurementLegend, normalizeAecMeasurementLegendRequest, validateAecMeasurementLegendResult } from './aec-measurement-legend-contract.mjs';

/** Deterministic, source-bound AEC measurement legend builder. */
export class AecMeasurementLegendService {
  generate(request, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some((key) => key !== 'signal') || (Object.hasOwn(options, 'signal') && (() => { const descriptor = Object.getOwnPropertyDescriptor(options, 'signal'); return descriptor?.get || descriptor?.set || descriptor?.enumerable !== true; })())) {
      const error = new TypeError('AEC legend options must contain only an optional signal.'); error.code = 'AEC_LEGEND_CONTRACT_INVALID'; throw error;
    }
    const signal = options.signal;
    if (signal !== undefined && (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal))) {
      const error = new TypeError('AEC legend signal is invalid.'); error.code = 'AEC_LEGEND_CONTRACT_INVALID'; throw error;
    }
    if (signal?.aborted) { const error = new Error('AEC measurement legend generation was cancelled.'); error.code = 'JOB_CANCELLED'; error.status = 499; throw error; }
    const normalized = normalizeAecMeasurementLegendRequest(request);
    return validateAecMeasurementLegendResult(createAecMeasurementLegend(normalized, { signal }));
  }

  create(request, options) { return this.generate(request, options); }
  build(request, options) { return this.generate(request, options); }
}

export function createAecMeasurementLegendService() { return new AecMeasurementLegendService(); }
