import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

const PREPRESS_OPERATIONS = Object.freeze([
  'preflight', 'ink-coverage', 'separations', 'overprint-preview',
]);
const PREFLIGHT_PROFILES = Object.freeze(['print-review', 'archive-review']);
const OUTPUT_INTENT_PROFILE = 'local-ghostscript-default-cmyk-output-intent-v1';

function definedOptions(options) {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
}

function validatePreviewOptions(operation, options) {
  const keys = Object.keys(definedOptions(options));
  if (operation === 'ink-coverage' && keys.length) {
    throw new TypeError('ink-coverage does not accept page or dpi options.');
  }
  if (operation === 'preflight') {
    if (keys.some((key) => key !== 'profile')
      || (options.profile !== undefined && !PREFLIGHT_PROFILES.includes(options.profile))) {
      throw new TypeError('preflight accepts only print-review or archive-review profile.');
    }
    return;
  }
  if (operation === 'ink-coverage') return;
  if (options.page !== undefined
    && (!Number.isSafeInteger(options.page) || options.page < 1 || options.page > 10_000)) {
    throw new TypeError('page must be an integer from 1 through 10000.');
  }
  if (options.dpi !== undefined
    && (!Number.isSafeInteger(options.dpi) || options.dpi < 36 || options.dpi > 300)) {
    throw new TypeError('dpi must be an integer from 36 through 300.');
  }
}

function validOptionsObject(options, keys) {
  return Boolean(options && typeof options === 'object' && !Array.isArray(options)
    && Object.keys(options).every((key) => keys.includes(key)));
}

function validOutputIntentRequest(request) {
  return Boolean(request && typeof request === 'object' && !Array.isArray(request)
    && Object.getPrototypeOf(request) === Object.prototype
    && Object.keys(request).length === 2
    && Object.keys(request).every((key) => ['profile', 'sourceSha256'].includes(key))
    && request.profile === OUTPUT_INTENT_PROFILE
    && typeof request.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(request.sourceSha256));
}

function runPrepressRequest(json, documentId, body, signal) {
  return postJson(
    json,
    documentEndpointPath(documentId, '/prepress'),
    body,
    signal,
  ).then((response) => response.result);
}

/** Prepress review, conversion, imposition, and production-validation transport. */
export function createPrepressEndpoints({ json }) {
  return {
    runPrepress(documentId, operation, { page, dpi, profile, signal } = {}) {
      if (!PREPRESS_OPERATIONS.includes(operation)) {
        throw new TypeError(
          'operation must be preflight, ink-coverage, separations, or overprint-preview.',
        );
      }
      const options = { page, dpi, profile };
      validatePreviewOptions(operation, options);
      return runPrepressRequest(
        json,
        documentId,
        { operation, ...definedOptions(options) },
        signal,
      );
    },
    convertToCmyk(documentId, options = {}) {
      if (!validOptionsObject(options, ['profile', 'signal'])) {
        throw new TypeError('CMYK conversion options are invalid.');
      }
      const { profile = 'ghostscript-default-cmyk', signal } = options;
      if (profile !== 'ghostscript-default-cmyk') {
        throw new TypeError(
          'CMYK conversion requires the fixed ghostscript-default-cmyk profile.',
        );
      }
      return runPrepressRequest(
        json,
        documentId,
        { operation: 'icc-convert', profile },
        signal,
      );
    },
    createImposition(documentId, options = {}) {
      if (!validOptionsObject(options, ['layout', 'marks', 'signal'])) {
        throw new TypeError('Imposition options are invalid.');
      }
      const { layout, marks, signal } = options;
      if (!['2x1', '2x2'].includes(layout) || typeof marks !== 'boolean') {
        throw new TypeError(
          'Imposition requires a 2x1 or 2x2 layout and boolean marks.',
        );
      }
      return runPrepressRequest(
        json,
        documentId,
        { operation: 'imposition', layout, marks },
        signal,
      );
    },
    runProductionValidation(documentId, options = {}) {
      if (!validOptionsObject(options, ['signal'])) {
        throw new TypeError('Production validation options are invalid.');
      }
      return runPrepressRequest(
        json,
        documentId,
        { operation: 'production-validation' },
        options.signal,
      );
    },
    assignOutputIntent(documentId, request, options = {}) {
      if (!validOutputIntentRequest(request)) {
        throw new TypeError(
          'OutputIntent assignment requires the fixed profile and current lowercase source SHA-256.',
        );
      }
      if (!validOptionsObject(options, ['signal'])) {
        throw new TypeError('OutputIntent assignment options are invalid.');
      }
      return postJson(
        json,
        documentEndpointPath(documentId, '/prepress/output-intent'),
        request,
        options.signal,
      ).then((response) => response.result);
    },
  };
}
