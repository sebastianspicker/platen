import { HostError } from '../host-error.mjs';
import { serializePreflightReportXml } from '../preflight-rules.mjs';
import { normalizeOutputIntentRequest } from '../prepress/output-intent-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const prepressOperations = Object.freeze({
  preflight: 'runPreflight',
  'ink-coverage': 'analyzeInkCoverage',
  separations: 'renderSeparations',
  'overprint-preview': 'renderOverprintPreview',
  'icc-convert': 'convertToCmyk',
  imposition: 'createImposition',
  'production-validation': 'runProductionValidation',
});

const privateArtifactKeys = new Set([
  'filePath', 'path', 'sourcePath', 'outputPath', 'sourceBytes', 'outputBytes', 'pdfBytes', 'privateBytes', 'buffer',
]);

function publicValue(value, depth = 0) {
  if (depth > 16) throw new HostError('INVALID_PREPRESS_RESULT', 'Local prepress returned an over-nested result.', 502);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => publicValue(item, depth + 1));
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new HostError('INVALID_PREPRESS_RESULT', 'Local prepress returned a non-public result value.', 502);
  }
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new HostError('INVALID_PREPRESS_RESULT', 'Local prepress returned an invalid public result.', 502);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new HostError('INVALID_PREPRESS_RESULT', 'Local prepress returned an invalid public result.', 502);
    }
    if (privateArtifactKeys.has(key) && (typeof descriptor.value === 'string'
      || Buffer.isBuffer(descriptor.value) || ArrayBuffer.isView(descriptor.value))) continue;
    copy[key] = publicValue(descriptor.value, depth + 1);
  }
  return copy;
}

function publicArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || typeof artifact.id !== 'string') {
    throw new HostError('INVALID_PREPRESS_RESULT', 'Local prepress did not return a retained artifact.', 502);
  }
  return {
    id: artifact.id,
    documentId: artifact.documentId,
    displayName: artifact.displayName,
    mediaType: artifact.mediaType,
    size: artifact.size,
    sha256: artifact.sha256,
    operation: publicValue(artifact.operation),
    createdAt: artifact.createdAt,
  };
}

function publicArtifactResult(result, operation) {
  if (!result || typeof result !== 'object') {
    throw new HostError('INVALID_PREPRESS_RESULT', 'Local prepress did not return a result.', 502);
  }
  const common = {
    kind: result.kind,
    schemaVersion: result.schemaVersion,
    sourceDigest: result.sourceDigest,
    artifact: publicArtifact(result.artifact),
    authoritative: result.authoritative,
    limitations: publicValue(result.limitations),
  };
  if (operation === 'icc-convert') {
    return { ...common, profile: publicValue(result.profile), recipe: publicValue(result.recipe), receipt: publicValue(result.receipt) };
  }
  if (operation === 'imposition') {
    return { ...common, layout: publicValue(result.layout), receipt: publicValue(result.receipt) };
  }
  return { ...common, profile: publicValue(result.profile), proof: publicValue(result.proof), receipt: publicValue(result.receipt) };
}

function publicPreflightResult(result, documentId, profile, store) {
  try {
    serializePreflightReportXml(result);
  } catch (cause) {
    throw new HostError(
      'INVALID_PREPRESS_RESULT',
      'Local prepress returned an invalid fixed-profile report.',
      502,
      { cause },
    );
  }
  const document = store.getDocument(documentId);
  if (!document || result.document.sha256 !== document.sha256
    || result.profile.id !== profile) {
    throw new HostError(
      'INVALID_PREPRESS_RESULT',
      'Local prepress returned a report for a different source or profile.',
      502,
    );
  }
  return publicValue(result);
}

async function projectArtifactResult(result, operation, store) {
  try {
    return publicArtifactResult(result, operation);
  } catch (error) {
    const artifactId = typeof result?.artifact?.id === 'string' ? result.artifact.id : null;
    if (!artifactId) throw error;
    try {
      await store.deleteArtifact(artifactId);
    } catch (cleanupError) {
      throw new HostError('PREPRESS_ARTIFACT_CLEANUP_FAILED', 'Local prepress could not revoke an invalid retained artifact.', 500, {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}

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
    request, response, documentId, processing, store, prepress,
    method, readJson, json, parsePositiveInteger,
  } = context;
  if (!prepress) throw new HostError('PREPRESS_UNAVAILABLE', 'Local prepress tools are unavailable.', 503);
  method(request, 'POST');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.operation !== 'string' || !Object.hasOwn(prepressOperations, body.operation)) {
    throw new HostError('INVALID_PREPRESS_OPERATION', 'Choose a supported local prepress operation.', 400);
  }
  const allowed = allowedPrepressKeys(body.operation);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HostError('INVALID_PREPRESS_OPTIONS', 'Prepress request contains unsupported options.', 400);
  }
  const options = prepressOptions(body, parsePositiveInteger);
  const prepressOperation = prepressOperations[body.operation];
  const result = await prepress[prepressOperation](
    documentId,
    { ...options, ...processing },
  );
  if (body.operation === 'icc-convert' || body.operation === 'imposition') {
    const publicResult = await projectArtifactResult(result, body.operation, store);
    if (await scheduleArtifactCleanup({ processing, response, store }, publicResult.artifact.id)) return true;
    json(response, 200, { result: publicResult });
    return true;
  }
  if (body.operation === 'preflight') {
    json(response, 200, {
      result: publicPreflightResult(result, documentId, options.profile, store),
    });
    return true;
  }
  json(response, 200, { result });
  return true;
}

export async function handleOutputIntentRoute(context) {
  if (context.operation !== 'prepress/output-intent') return false;
  const {
    request, response, url, documentId, processing, store, prepress,
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
  const publicResult = await projectArtifactResult(result, 'output-intent', store);
  if (await scheduleArtifactCleanup({ processing, response, store }, publicResult.artifact.id)) return true;
  json(response, 201, { result: publicResult });
  return true;
}
