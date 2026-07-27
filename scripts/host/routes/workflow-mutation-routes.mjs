import { HostError } from '../host-error.mjs';

const WORKSPACE_JSON_BODY_LIMIT = 768 * 1024;
const rasterOperations = Object.freeze({
  rotate: 'rotatePages',
  crop: 'cropPages',
  resize: 'resizePages',
  overlay: 'addOverlayText',
  redact: 'redact',
  flatten: 'flatten',
});
const comparisonOperations = Object.freeze({
  content: 'compareContent',
  pixel: 'comparePixels',
  'cross-format': 'compareCrossFormat',
  overlay: 'describeOverlay',
  'side-by-side': 'describeSideBySide',
  annotations: 'compareAnnotations',
});

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function validRedactionTargetShapes(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || !Array.isArray(parameters.redactions)) return false;
  return parameters.redactions.every((entry) => (
    exactJsonObject(entry, ['page', 'removedText', 'fullPage'])
      ? entry.fullPage === true
      : exactJsonObject(entry, ['page', 'removedText', 'region'])
        && exactJsonObject(entry.region, ['x', 'y', 'width', 'height'])
  ));
}

export async function handleRasterMutationRoute(context) {
  const {
    request, response, documentId, processing, rasterMutations, method, readJson, json,
  } = context;
  if (!rasterMutations) {
    throw new HostError('RASTER_MUTATION_UNAVAILABLE', 'Local raster mutation is unavailable.', 503);
  }
  method(request, 'POST');
  const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
  if (typeof body.operation !== 'string' || !(body.operation in rasterOperations)) {
    throw new HostError('INVALID_OPERATION', 'Choose a supported raster mutation operation.', 400);
  }
  if (body.parameters !== undefined
    && (!body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters))) {
    throw new HostError('INVALID_PARAMETERS', 'Raster mutation parameters must be a JSON object.', 400);
  }
  if (body.operation === 'redact' && !validRedactionTargetShapes(body.parameters)) {
    throw new HostError('INVALID_PARAMETERS', 'Redaction targets must be exact full-page or regional objects.', 400);
  }
  if (body.operation === 'redact' && body.parameters?.planBinding !== undefined) {
    throw new HostError('INVALID_PARAMETERS', 'Redaction plan binding is reserved for source-bound plan application.', 400);
  }
  const artifact = await rasterMutations[rasterOperations[body.operation]](
    documentId,
    body.parameters ?? {},
    processing,
  );
  json(response, 201, { artifact });
}

export async function handleComparisonRoute(context) {
  const {
    request, response, documentId, processing, comparisons, method, readJson, json,
  } = context;
  if (!comparisons) {
    throw new HostError('COMPARISON_UNAVAILABLE', 'Local document comparison is unavailable.', 503);
  }
  method(request, 'POST');
  const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
  if (typeof body.secondaryDocumentId !== 'string') {
    throw new HostError('INVALID_COMPARISON', 'A secondary local document identifier is required.', 400);
  }
  if (typeof body.mode !== 'string' || !(body.mode in comparisonOperations)) {
    throw new HostError('UNSUPPORTED_COMPARISON_MODE', 'Choose a supported local comparison mode.', 400);
  }
  if (body.options !== undefined
    && (!body.options || typeof body.options !== 'object' || Array.isArray(body.options))) {
    throw new HostError('INVALID_COMPARISON_OPTIONS', 'Comparison options must be a JSON object.', 400);
  }
  const report = await comparisons[comparisonOperations[body.mode]](
    documentId,
    body.secondaryDocumentId,
    { ...(body.options ?? {}), ...processing },
  );
  json(response, 200, { report });
}

export async function handleComparisonBatchRoute(context) {
  const { pathname, request, response, processing, comparisons, method, readJson, json } = context;
  if (pathname !== '/api/comparisons/batch') return false;
  if (!comparisons) {
    throw new HostError('COMPARISON_UNAVAILABLE', 'Local document comparison is unavailable.', 503);
  }
  method(request, 'POST');
  const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
  const report = await comparisons.compareBatch(body.pairs, { mode: body.mode, ...processing });
  json(response, 200, { report });
  return true;
}
