import { HostError } from '../host-error.mjs';
import { normalizePdfTextReflowRequest, PDF_TEXT_REFLOW_PROFILE } from '../pdf-text-reflow-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const ARTIFACT_KEYS = Object.freeze([
  'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
]);
const OPERATION_KEYS = Object.freeze([
  'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
]);

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value')
      && descriptors[key].enumerable === true);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validOperation(operation, { documentId, sourceSha256, outputSha256, request }) {
  if (!exact(operation, OPERATION_KEYS)
    || operation.schemaVersion !== 1
    || !UUID.test(operation.id ?? '')
    || operation.type !== 'pdf-text-reflow'
    || !Array.isArray(operation.inputs)
    || operation.inputs.length !== 1
    || !exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    || operation.inputs[0].documentId !== documentId
    || operation.inputs[0].sha256 !== sourceSha256
    || operation.inputs[0].role !== 'source'
    || !exact(operation.parameters, [
      'profile', 'page', 'streamReference', 'lineCount', 'lineWidth',
      'originalTextSha256', 'replacementTextSha256',
    ])
    || operation.parameters.profile !== PDF_TEXT_REFLOW_PROFILE
    || operation.parameters.page !== request.page
    || operation.parameters.lineWidth !== request.lineWidth
    || operation.parameters.originalTextSha256 !== request.originalTextSha256
    || !SHA256.test(operation.parameters.replacementTextSha256 ?? '')
    || !exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'streamByteLengthPreserved', 'changedObjectCount'])
    || operation.expected.outputSha256 !== outputSha256
    || operation.expected.sourcePrefixPreserved !== true
    || operation.expected.streamByteLengthPreserved !== true
    || operation.expected.changedObjectCount !== 1
    || !exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    || operation.validation.passed !== true
    || operation.validation.outputSha256 !== outputSha256
    || !Array.isArray(operation.validation.validators)
    || !operation.validation.validators.includes('independent-text-reflow-reinspection')
    || !canonicalTimestamp(operation.completedAt)) return false;
  return true;
}

function validArtifact(artifact, { documentId, sourceSha256, proof, request }) {
  if (!exact(artifact, ARTIFACT_KEYS)
    || !UUID.test(artifact.id ?? '')
    || artifact.id === documentId
    || artifact.documentId !== documentId
    || artifact.displayName !== 'text-reflow.pdf'
    || artifact.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(artifact.size) || artifact.size < 64 || artifact.size > 65 * 1024 * 1024
    || !SHA256.test(artifact.sha256 ?? '') || artifact.sha256 === sourceSha256
    || !canonicalTimestamp(artifact.createdAt)) return false;
  return validOperation(artifact.operation, {
    documentId, sourceSha256, outputSha256: artifact.sha256, request,
  }) && artifact.operation.parameters.streamReference === proof.streamReference;
}

function validProof(proof, { sourceSha256, request, outputSha256 }) {
  return exact(proof, [
    'profile', 'sourceSha256', 'outputSha256', 'sourcePrefixPreserved', 'page',
    'streamReference', 'lineCount', 'lineWidth', 'originalTextSha256',
    'replacementTextSha256', 'fixedSlotReflow', 'textPositionsPreserved',
    'typographyPreserved', 'streamByteLengthPreserved', 'revisionCount',
    'changedObjectCount',
  ])
    && proof.profile === PDF_TEXT_REFLOW_PROFILE
    && proof.sourceSha256 === sourceSha256
    && proof.outputSha256 === outputSha256
    && proof.sourcePrefixPreserved === true
    && proof.page === request.page
    && proof.lineWidth === request.lineWidth
    && proof.originalTextSha256 === request.originalTextSha256
    && proof.replacementTextSha256 && SHA256.test(proof.replacementTextSha256)
    && proof.fixedSlotReflow === true
    && proof.textPositionsPreserved === true
    && proof.typographyPreserved === true
    && proof.streamByteLengthPreserved === true
    && Number.isSafeInteger(proof.lineCount) && proof.lineCount === request.lineTokenIndices.length
    && Number.isSafeInteger(proof.revisionCount) && proof.revisionCount >= 2
    && proof.changedObjectCount === 1;
}

function validateResult(result, context) {
  if (!exact(result, ['kind', 'artifact', 'proof', 'limitations'])
    || result.kind !== 'pdf-text-reflow'
    || !Array.isArray(result.limitations) || result.limitations.length < 1
    || result.limitations.some((item) => typeof item !== 'string' || item.length < 1)
    || !validProof(result.proof, context)
    || !validArtifact(result.artifact, { ...context, proof: result.proof })) {
    throw new HostError('PDF_TEXT_REFLOW_OUTPUT_INVALID', 'The text-reflow service returned an invalid retained result.', 502);
  }
  return result;
}

export async function handleTextReflowRoute(context) {
  if (context.operation !== 'text-reflow') return false;
  const {
    request, response, url, documentId, processing, store, textReflow,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Text reflow does not accept query parameters.', 400);
  }
  if (!textReflow || typeof textReflow.reflow !== 'function') {
    throw new HostError('PDF_TEXT_REFLOW_UNAVAILABLE', 'The local text-reflow service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  const keys = [
    'profile', 'sourceSha256', 'page', 'streamRef', 'lineTokenIndices',
    'lineWidth', 'originalTextSha256', 'replacementText',
  ];
  if (!exactJsonObject(body, keys) || body.profile !== PDF_TEXT_REFLOW_PROFILE || !SHA256.test(body.sourceSha256 ?? '')) {
    throw new HostError('PDF_TEXT_REFLOW_OPTIONS_INVALID', 'Text reflow requires the fixed profile and current source SHA-256.', 400);
  }
  let current;
  try {
    current = store.getDocument(documentId);
  } catch (error) {
    throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'The text-reflow source document is unavailable.', 404, { cause: error });
  }
  if (current.sha256 !== body.sourceSha256) {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'The text-reflow source digest does not match the current document.', 409);
  }
  let value;
  try {
    value = normalizePdfTextReflowRequest(body);
  } catch (error) {
    throw new HostError('PDF_TEXT_REFLOW_OPTIONS_INVALID', 'Text-reflow options are outside the bounded contract.', 400, { cause: error });
  }
  const result = await textReflow.reflow(documentId, value, { signal: processing.signal });
  const checked = validateResult(result, {
    documentId,
    sourceSha256: body.sourceSha256,
    request: value,
    outputSha256: result?.artifact?.sha256,
  });
  if (await scheduleArtifactCleanup({ processing, response, store }, checked.artifact.id)) return true;
  json(response, 201, { result: checked });
  return true;
}

export { validateResult as validateTextReflowResult };
