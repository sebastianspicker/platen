import { HostError } from '../host-error.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const BOUND_OPERATIONS = new Set([
  'createToolset',
  'createReviewSession',
  'measurementToolset',
  'createMarkup',
  'createSheet',
  'createSpace',
  'createDrawingSet',
  'createRevisionOverlay',
  'createBatchPlan',
  'createCustomColumn',
  'evaluateCustomColumn',
  'calibrateGeoPage',
  'pageToGeo',
  'listMarkups',
  'takeoff',
]);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/u;

function invalid(label) {
  throw new HostError('INVALID_PARAMETER', `Invalid AEC ${label}.`, 400);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  return structuredClone(value);
}

function sha256(value, label) {
  if (typeof value !== 'string') invalid(label);
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) invalid(label);
  return normalized;
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(label);
  return value;
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(label);
  return value;
}

function assertBinding(providedSource, providedRevision, trustedSource, currentRevision) {
  if (providedSource !== trustedSource) {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'AEC request source digest does not match the current document.', 409);
  }
  if (providedRevision !== currentRevision) {
    throw new HostError('REVISION_CONFLICT', 'AEC request revision does not match the current workspace.', 409);
  }
}

function boundedFilter(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 160) invalid(label);
  return value.trim();
}

function pageFilter(value, label = 'markup page') {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) invalid(label);
  return value;
}

function bindSourceBoundDocument(documentId, workspaceState, store) {
  const document = store.getDocument(documentId);
  return {
    trustedSource: sha256(document.sha256, 'trusted source digest'),
    currentRevision: workspaceState.snapshot(documentId).revision,
  };
}

function bindSourceBoundListMarkups(request, body, trustedSource, currentRevision) {
  const query = plain(body.query, 'markup-list query');
  const providedSource = sha256(query.sourceSha256, 'markup-list source digest');
  const providedRevision = revision(query.expectedRevision, 'markup-list expected revision');
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  const type = boundedFilter(query.type, 'markup type');
  const status = boundedFilter(query.status, 'markup status');
  const page = pageFilter(query.page);
  body.query = {
    sourceSha256: trustedSource,
    expectedRevision: currentRevision,
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(page === undefined ? {} : { page }),
  };
  return { ...request, body };
}

function bindSourceBoundCreateCustomColumn(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'createCustomColumn input');
  if (!Object.hasOwn(input, 'sourceSha256')) return request;
  const topLevel = exactKeys(body, ['input', 'options'], 'createCustomColumn body');
  exactKeys(input, ['id', 'name', 'formula', 'sourceSha256'], 'createCustomColumn input');
  const options = exactKeys(plain(topLevel.options, 'createCustomColumn options'), ['expectedRevision'], 'createCustomColumn options');
  const providedSource = sha256(input.sourceSha256, 'createCustomColumn source digest');
  const providedRevision = revision(options.expectedRevision, 'createCustomColumn expected revision');
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  return {
    ...request,
    body: {
      ...topLevel,
      input: { ...input, sourceSha256: trustedSource },
      options: { ...options, expectedRevision: currentRevision },
    },
  };
}

function bindSourceBoundEvaluateCustomColumn(request, body, trustedSource, currentRevision) {
  if (!Object.hasOwn(body, 'sourceSha256')) return request;
  const values = plain(body.values, 'evaluateCustomColumn values');
  const keys = Object.keys(values);
  if (keys.length === 0 || keys.length > 32) invalid('evaluateCustomColumn values');
  for (const [key, value] of Object.entries(values)) {
    if (!IDENTIFIER.test(key) || !Number.isFinite(value) || value < -1e12 || value > 1e12) {
      invalid('evaluateCustomColumn values');
    }
  }
  const topLevel = exactKeys(body, ['columnId', 'values', 'sourceSha256', 'options'], 'evaluateCustomColumn body');
  const options = exactKeys(plain(topLevel.options, 'evaluateCustomColumn options'), ['expectedRevision'], 'evaluateCustomColumn options');
  const providedSource = sha256(topLevel.sourceSha256, 'evaluateCustomColumn source digest');
  const providedRevision = revision(options.expectedRevision, 'evaluateCustomColumn expected revision');
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  return {
    ...request,
    body: {
      ...topLevel,
      values,
      sourceSha256: trustedSource,
      options: { ...options, sourceSha256: trustedSource, expectedRevision: currentRevision },
    },
  };
}

function bindSourceBoundCalibrateGeoPage(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'calibrateGeoPage input');
  if (!Object.hasOwn(input, 'sourceSha256')) return request;
  const topLevel = exactKeys(body, ['input', 'options'], 'calibrateGeoPage body');
  exactKeys(input, ['id', 'page', 'origin', 'scale', 'rotation', 'sourceSha256'], 'calibrateGeoPage input');
  if (input.page === undefined || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 100_000) {
    invalid('calibrateGeoPage page');
  }
  const origin = plain(input.origin, 'calibrateGeoPage origin');
  if (!Object.hasOwn(origin, 'x') || !Object.hasOwn(origin, 'y') || Object.keys(origin).length !== 2) {
    invalid('calibrateGeoPage origin');
  }
  exactKeys(origin, ['x', 'y'], 'calibrateGeoPage origin');
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)
    || origin.x < -1_000_000 || origin.x > 1_000_000 || origin.y < -1_000_000 || origin.y > 1_000_000) {
    invalid('calibrateGeoPage origin');
  }
  if (typeof input.rotation !== 'number' || !Number.isFinite(input.rotation) || input.rotation < -360 || input.rotation > 360) {
    invalid('calibrateGeoPage rotation');
  }
  if (typeof input.scale !== 'number' || !Number.isFinite(input.scale) || input.scale <= 0 || input.scale > 100_000) {
    invalid('calibrateGeoPage scale');
  }
  const options = exactKeys(plain(topLevel.options, 'calibrateGeoPage options'), ['expectedRevision'], 'calibrateGeoPage options');
  const providedSource = sha256(input.sourceSha256, 'calibrateGeoPage source digest');
  const providedRevision = revision(options.expectedRevision, 'calibrateGeoPage expected revision');
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  return {
    ...request,
    body: {
      ...topLevel,
      input: { ...input, sourceSha256: trustedSource },
      options: { ...options, expectedRevision: currentRevision },
    },
  };
}

function bindSourceBoundPageToGeo(request, body, trustedSource, currentRevision) {
  if (!Object.hasOwn(body, 'sourceSha256')) return request;
  const topLevel = exactKeys(body, ['calibrationId', 'pagePoint', 'sourceSha256', 'options'], 'pageToGeo body');
  const pagePoint = plain(topLevel.pagePoint, 'pageToGeo pagePoint');
  if (!Object.hasOwn(pagePoint, 'x') || !Object.hasOwn(pagePoint, 'y') || Object.keys(pagePoint).length !== 2) {
    invalid('pageToGeo pagePoint');
  }
  exactKeys(pagePoint, ['x', 'y'], 'pageToGeo pagePoint');
  if (!Number.isFinite(pagePoint.x) || !Number.isFinite(pagePoint.y)
    || pagePoint.x < -1_000_000 || pagePoint.x > 1_000_000 || pagePoint.y < -1_000_000 || pagePoint.y > 1_000_000) {
    invalid('pageToGeo pagePoint');
  }
  const options = exactKeys(plain(topLevel.options, 'pageToGeo options'), ['expectedRevision'], 'pageToGeo options');
  const providedSource = sha256(topLevel.sourceSha256, 'pageToGeo source digest');
  const providedRevision = revision(options.expectedRevision, 'pageToGeo expected revision');
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  return {
    ...request,
    body: {
      ...topLevel,
      pagePoint,
      sourceSha256: trustedSource,
      options: { ...options, sourceSha256: trustedSource, expectedRevision: currentRevision },
    },
  };
}

function sourceBoundOptions(body, operation, trustedSource, currentRevision) {
  const options = exactKeys(
    plain(body.options, `${operation} options`),
    ['expectedRevision'],
    `${operation} options`,
  );
  const providedRevision = revision(options.expectedRevision, `${operation} expected revision`);
  const providedSource = sha256(body.input.sourceSha256, `${operation} source digest`);
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  return { ...options, expectedRevision: currentRevision };
}

function bindSourceBoundToolset(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'createToolset input');
  if (!Object.hasOwn(input, 'sourceSha256')) return request;
  exactKeys(body, ['input', 'options'], 'createToolset body');
  exactKeys(input, ['id', 'name', 'tools', 'sourceSha256'], 'createToolset input');
  return {
    ...request,
    body: {
      input: { ...input, sourceSha256: trustedSource },
      options: sourceBoundOptions(body, 'createToolset', trustedSource, currentRevision),
    },
  };
}

function bindSourceBoundReviewSession(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'createReviewSession input');
  exactKeys(body, ['input', 'options'], 'createReviewSession body');
  exactKeys(
    input,
    ['id', 'workspaceId', 'participants', 'sourceSha256'],
    'createReviewSession input',
  );
  if (!Array.isArray(input.participants)
    || input.participants.length < 1 || input.participants.length > 50) {
    invalid('createReviewSession participants');
  }
  return {
    ...request,
    body: {
      input: { ...input, sourceSha256: trustedSource },
      options: sourceBoundOptions(body, 'createReviewSession', trustedSource, currentRevision),
    },
  };
}

function bindSourceBoundMeasurementToolset(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'measurementToolset input');
  exactKeys(body, ['input', 'options'], 'measurementToolset body');
  exactKeys(input, ['sourceSha256'], 'measurementToolset input');
  return {
    ...request,
    body: {
      input: { sourceSha256: trustedSource },
      options: sourceBoundOptions(body, 'measurementToolset', trustedSource, currentRevision),
    },
  };
}

function bindSourceBoundDrawingSet(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'createDrawingSet input');
  if (!Object.hasOwn(input, 'sourceSha256')) return request;
  exactKeys(body, ['input', 'options'], 'createDrawingSet body');
  exactKeys(
    input,
    ['id', 'name', 'sheets', 'initialLog', 'sourceSha256'],
    'createDrawingSet input',
  );
  if (!Array.isArray(input.sheets)) {
    invalid('createDrawingSet sheets');
  }
  const initialLog = plain(input.initialLog, 'createDrawingSet initialLog');
  exactKeys(initialLog, ['revisionLabel', 'date'], 'createDrawingSet initialLog');
  if (Object.keys(initialLog).length !== 2) invalid('createDrawingSet initialLog');
  return {
    ...request,
    body: {
      input: { ...input, initialLog, sourceSha256: trustedSource },
      options: sourceBoundOptions(body, 'createDrawingSet', trustedSource, currentRevision),
    },
  };
}

function bindSourceBoundRevisionOverlay(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'createRevisionOverlay input');
  if (!Object.hasOwn(input, 'sourceSha256')) return request;
  exactKeys(body, ['input', 'options'], 'createRevisionOverlay body');
  exactKeys(
    input,
    ['id', 'fromDigest', 'toDigest', 'sheetId', 'sourceSha256'],
    'createRevisionOverlay input',
  );
  return {
    ...request,
    body: {
      input: { ...input, sourceSha256: trustedSource },
      options: sourceBoundOptions(body, 'createRevisionOverlay', trustedSource, currentRevision),
    },
  };
}

function bindSourceBoundBatchPlan(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, 'createBatchPlan input');
  if (!Object.hasOwn(input, 'sourceSha256')) return request;
  exactKeys(body, ['input', 'options'], 'createBatchPlan body');
  exactKeys(input, ['id', 'kind', 'pairs', 'sourceSha256'], 'createBatchPlan input');
  if (!Array.isArray(input.pairs) || input.pairs.length < 1 || input.pairs.length > 100) {
    invalid('createBatchPlan pairs');
  }
  for (const pair of input.pairs) {
    exactKeys(plain(pair, 'createBatchPlan pair'), ['from', 'to'], 'createBatchPlan pair');
  }
  return {
    ...request,
    body: {
      input: { ...input, sourceSha256: trustedSource },
      options: sourceBoundOptions(body, 'createBatchPlan', trustedSource, currentRevision),
    },
  };
}

function bindSourceBoundMutation(request, body, trustedSource, currentRevision) {
  const input = plain(body.input, `${request.operation} input`);
  if (request.operation === 'createSheet' || request.operation === 'createSpace') {
    pageFilter(input.page, `${request.operation} page`);
  }
  const options = plain(body.options, `${request.operation} options`);
  const providedSource = sha256(input.sourceSha256, `${request.operation} source digest`);
  const providedRevision = revision(options.expectedRevision, `${request.operation} expected revision`);
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);
  body.input = { ...input, sourceSha256: trustedSource };
  body.options = { ...options, expectedRevision: currentRevision };
  return { ...request, body };
}

export function bindSourceBoundAecDomainRequest(documentId, request, workspaceState, store) {
  if (!request || request.group !== 'AEC' || !BOUND_OPERATIONS.has(request.operation)) return request;
  const body = plain(request.body, 'domain body');
  const { trustedSource, currentRevision } = bindSourceBoundDocument(documentId, workspaceState, store);

  if (request.operation === 'listMarkups') {
    return bindSourceBoundListMarkups(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'createCustomColumn') {
    return bindSourceBoundCreateCustomColumn(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'evaluateCustomColumn') {
    return bindSourceBoundEvaluateCustomColumn(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'calibrateGeoPage') {
    return bindSourceBoundCalibrateGeoPage(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'pageToGeo') {
    return bindSourceBoundPageToGeo(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'createToolset') {
    return bindSourceBoundToolset(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'createReviewSession') {
    return bindSourceBoundReviewSession(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'measurementToolset') {
    return bindSourceBoundMeasurementToolset(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'createDrawingSet') {
    return bindSourceBoundDrawingSet(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'createRevisionOverlay') {
    return bindSourceBoundRevisionOverlay(request, body, trustedSource, currentRevision);
  }

  if (request.operation === 'createBatchPlan') {
    return bindSourceBoundBatchPlan(request, body, trustedSource, currentRevision);
  }

  return bindSourceBoundMutation(request, body, trustedSource, currentRevision);
}
