import { isProxy } from 'node:util/types';
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
const LOCAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPARISON_MAX_PAGE = 200;
const COMPARISON_MAX_PAIRS = 8;

function dataObject(value, keys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
  let prototype; let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype) return null;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (keys && (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)))) return null;
  if (ownKeys.some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) return null;
  if (!keys) return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function dataArray(value) {
  if (!Array.isArray(value) || isProxy(value)) return null;
  let prototype; let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (prototype !== Array.prototype) return null;
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some((key) => key !== 'length'
    && (typeof key !== 'string' || !/^\d+$/u.test(key) || Number(key) >= length))) return null;
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    values.push(descriptor.value);
  }
  return values;
}

function exactJsonObject(value, keys) {
  return dataObject(value, keys) !== null;
}

function boundedPage(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= COMPARISON_MAX_PAGE;
}

function boundedPages(value) {
  const pages = dataArray(value);
  if (!pages || pages.length < 1 || pages.length > COMPARISON_MAX_PAGE
    || pages.some((page) => !boundedPage(page))) return false;
  return new Set(pages).size === pages.length;
}

function boundedDpi(value) {
  return Number.isSafeInteger(value) && value >= 36 && value <= 240;
}

function optionObject(value, keys) {
  const options = dataObject(value);
  if (!options) return null;
  const names = Object.keys(options);
  if (names.some((key) => !keys.includes(key))) return null;
  return options;
}

function validComparisonOptions(mode, value) {
  if (mode === 'content' || mode === 'annotations' || mode === 'cross-format') {
    return exactJsonObject(value, []) ? {} : null;
  }
  if (mode === 'pixel') {
    const options = optionObject(value, ['pages', 'dpi']);
    if (!options || (Object.hasOwn(options, 'pages') && !boundedPages(options.pages))
      || (Object.hasOwn(options, 'dpi') && !boundedDpi(options.dpi))) return null;
    return options;
  }
  if (mode === 'overlay') {
    const options = optionObject(value, ['page', 'opacity']);
    if (!options || (Object.hasOwn(options, 'page') && !boundedPage(options.page))
      || (Object.hasOwn(options, 'opacity')
        && (typeof options.opacity !== 'number' || !Number.isFinite(options.opacity)
          || options.opacity <= 0 || options.opacity >= 1))) return null;
    return options;
  }
  if (mode === 'side-by-side') {
    const options = optionObject(value, ['page']);
    if (!options || (Object.hasOwn(options, 'page') && !boundedPage(options.page))) return null;
    return options;
  }
  return null;
}

function hasQueryParameters(context) {
  const { url, request } = context;
  if (url && typeof url.search === 'string') return url.search !== '';
  if (typeof request?.url !== 'string') return false;
  try {
    return new URL(request.url, 'http://127.0.0.1').search !== '';
  } catch {
    return true;
  }
}

function invalidComparison(message = 'Comparison request is outside the bounded local contract.') {
  throw new HostError('INVALID_COMPARISON', message, 400);
}

function invalidComparisonOptions() {
  throw new HostError('INVALID_COMPARISON_OPTIONS', 'Comparison options are outside the bounded local contract.', 400);
}

function validateBatchPair(pair, mode) {
  const allowed = mode === 'pixel'
    ? ['primaryDocumentId', 'secondaryDocumentId', 'pages', 'dpi']
    : ['primaryDocumentId', 'secondaryDocumentId'];
  const value = dataObject(pair);
  if (!value) return null;
  const keys = Object.keys(value);
  if (keys.length < 2 || keys.some((key) => !allowed.includes(key))) return null;
  if (mode === 'content' && keys.length !== 2) return null;
  if (!LOCAL_UUID.test(value.primaryDocumentId ?? '')
    || !LOCAL_UUID.test(value.secondaryDocumentId ?? '')
    || value.primaryDocumentId === value.secondaryDocumentId) return null;
  if (mode === 'pixel'
    && ((Object.hasOwn(value, 'pages') && !boundedPages(value.pages))
      || (Object.hasOwn(value, 'dpi') && !boundedDpi(value.dpi)))) return null;
  return value;
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
  if (hasQueryParameters(context)) {
    throw new HostError('INVALID_PARAMETER', 'Comparisons do not accept query parameters.', 400);
  }
  const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
  const requestBody = dataObject(body, ['secondaryDocumentId', 'mode', 'options']);
  if (!requestBody || typeof requestBody.secondaryDocumentId !== 'string'
    || !LOCAL_UUID.test(requestBody.secondaryDocumentId)
    || requestBody.secondaryDocumentId === documentId) {
    invalidComparison('A distinct local UUID-like secondary document identifier is required.');
  }
  if (typeof requestBody.mode !== 'string' || !(requestBody.mode in comparisonOperations)) {
    throw new HostError('UNSUPPORTED_COMPARISON_MODE', 'Choose a supported local comparison mode.', 400);
  }
  const options = validComparisonOptions(requestBody.mode, requestBody.options);
  if (!options) invalidComparisonOptions();
  const report = await comparisons[comparisonOperations[requestBody.mode]](
    documentId,
    requestBody.secondaryDocumentId,
    { ...options, ...processing },
  );
  json(response, 200, { report });
}

export async function handleComparisonBatchRoute(context) {
  const {
    pathname, request, response, processing, comparisons, method, readJson, json,
  } = context;
  if (pathname !== '/api/comparisons/batch') return false;
  if (!comparisons) {
    throw new HostError('COMPARISON_UNAVAILABLE', 'Local document comparison is unavailable.', 503);
  }
  method(request, 'POST');
  if (hasQueryParameters(context)) {
    throw new HostError('INVALID_PARAMETER', 'Comparison batches do not accept query parameters.', 400);
  }
  const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
  const requestBody = dataObject(body, ['pairs', 'mode']);
  if (!requestBody || !['content', 'pixel'].includes(requestBody.mode)) {
    throw new HostError('UNSUPPORTED_COMPARISON_MODE', 'Batch comparison supports content or pixel modes only.', 400);
  }
  const pairs = dataArray(requestBody.pairs);
  if (!pairs || pairs.length < 1 || pairs.length > COMPARISON_MAX_PAIRS) {
    throw new HostError('BATCH_LIMIT', `Compare from one through ${COMPARISON_MAX_PAIRS} document pairs per batch.`, 400);
  }
  const validatedPairs = pairs.map((pair) => validateBatchPair(pair, requestBody.mode));
  if (validatedPairs.some((pair) => pair === null)) {
    throw new HostError('INVALID_BATCH_PAIR', 'Each batch item must contain two distinct local UUID-like document identifiers.', 400);
  }
  const report = await comparisons.compareBatch(validatedPairs, { mode: requestBody.mode, ...processing });
  json(response, 200, { report });
  return true;
}
