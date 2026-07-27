import { HostError } from '../host-error.mjs';
import { normalizeOutputIntentRequest } from '../prepress/output-intent-contract.mjs';

const prepressOperations = Object.freeze({
  preflight: 'runPreflight',
  'ink-coverage': 'analyzeInkCoverage',
  separations: 'renderSeparations',
  'overprint-preview': 'renderOverprintPreview',
  'icc-convert': 'convertToCmyk',
  imposition: 'createImposition',
  'production-validation': 'runProductionValidation',
});

function allowedPrepressKeys(operation) {
  if (operation === 'ink-coverage' || operation === 'production-validation') {
    return new Set(['operation']);
  }
  if (operation === 'preflight' || operation === 'icc-convert') {
    return new Set(['operation', 'profile']);
  }
  if (operation === 'imposition') return new Set(['operation', 'layout', 'marks']);
  return new Set(['operation', 'page', 'dpi']);
}

function prepressOptions(body, parsePositiveInteger) {
  const options = {};
  if (body.operation === 'preflight') {
    if (body.profile !== undefined && !['print-review', 'archive-review'].includes(body.profile)) {
      throw new HostError('INVALID_PREFLIGHT_PROFILE', 'Choose print-review or archive-review.', 400);
    }
    options.profile = body.profile ?? 'print-review';
  } else if (body.operation === 'icc-convert') {
    if (body.profile !== 'ghostscript-default-cmyk') {
      throw new HostError(
        'INVALID_ICC_PROFILE',
        'ICC conversion requires the fixed ghostscript-default-cmyk profile.',
        400,
      );
    }
    options.profile = body.profile;
  } else if (body.operation === 'imposition') {
    if (!['2x1', '2x2'].includes(body.layout) || typeof body.marks !== 'boolean') {
      throw new HostError(
        'INVALID_IMPOSITION_OPTIONS',
        'Imposition requires a 2x1 or 2x2 layout and boolean marks.',
        400,
      );
    }
    options.layout = body.layout;
    options.marks = body.marks;
  } else if (body.operation !== 'ink-coverage') {
    if (body.page !== undefined) {
      options.page = parsePositiveInteger(body.page, 'page', { maximum: 10_000 });
    }
    if (body.dpi !== undefined) {
      options.dpi = parsePositiveInteger(body.dpi, 'dpi', { minimum: 36, maximum: 300 });
    }
  }
  return options;
}

export async function handlePrepressRoute(context) {
  const {
    request, response, documentId, processing, prepress,
    method, readJson, json, parsePositiveInteger,
  } = context;
  if (!prepress) throw new HostError('PREPRESS_UNAVAILABLE', 'Local prepress tools are unavailable.', 503);
  method(request, 'POST');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.operation !== 'string' || !(body.operation in prepressOperations)) {
    throw new HostError('INVALID_PREPRESS_OPERATION', 'Choose a supported local prepress operation.', 400);
  }
  const allowed = allowedPrepressKeys(body.operation);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HostError('INVALID_PREPRESS_OPTIONS', 'Prepress request contains unsupported options.', 400);
  }
  const options = prepressOptions(body, parsePositiveInteger);
  const result = await prepress[prepressOperations[body.operation]](
    documentId,
    { ...options, ...processing },
  );
  json(response, 200, { result });
}

export async function handleOutputIntentRoute(context) {
  if (context.operation !== 'prepress/output-intent') return false;
  const {
    request, response, url, documentId, processing, prepress,
    method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError(
      'INVALID_OUTPUT_INTENT_REQUEST',
      'OutputIntent assignment does not accept query parameters.',
      400,
    );
  }
  if (!prepress || typeof prepress.assignOutputIntent !== 'function') {
    throw new HostError('PREPRESS_UNAVAILABLE', 'Local prepress tools are unavailable.', 503);
  }
  const body = await readJson(request, 2_048);
  try {
    normalizeOutputIntentRequest(body);
  } catch (error) {
    throw new HostError('INVALID_OUTPUT_INTENT_REQUEST', error.message, 400, { cause: error });
  }
  const result = await prepress.assignOutputIntent(
    documentId,
    body,
    { signal: processing.signal },
  );
  json(response, 201, { result });
  return true;
}
