import { PlatenError } from './errors.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_TEXT_REFLOW_PROFILE = 'local-pdf-text-reflow-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PAGES = 10_000;
const MAX_LINES = 32;
const MAX_LINE_WIDTH = 128;
const MAX_TEXT_BYTES = 4_096;

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

function dense(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => descriptors[index])
    .every((descriptor) => descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}

function validRequest(value) {
  if (!exact(value, [
    'profile', 'sourceSha256', 'page', 'streamRef', 'lineTokenIndices',
    'lineWidth', 'originalTextSha256', 'replacementText',
  ]) || value.profile !== PDF_TEXT_REFLOW_PROFILE
    || !SHA256.test(value.sourceSha256 ?? '')
    || !SHA256.test(value.originalTextSha256 ?? '')
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > MAX_PAGES
    || !exact(value.streamRef, ['object', 'generation'])
    || !Number.isSafeInteger(value.streamRef.object) || value.streamRef.object < 1 || value.streamRef.object > 1_000_000
    || !Number.isSafeInteger(value.streamRef.generation) || value.streamRef.generation < 0 || value.streamRef.generation > 65_535
    || !dense(value.lineTokenIndices, 2, MAX_LINES)
    || value.lineTokenIndices.some((item, index) => !Number.isSafeInteger(item) || item < 0 || item > 200_000
      || (index > 0 && item <= value.lineTokenIndices[index - 1]))
    || !Number.isSafeInteger(value.lineWidth) || value.lineWidth < 4 || value.lineWidth > MAX_LINE_WIDTH
    || typeof value.replacementText !== 'string'
    || value.replacementText.length < 1
    || Buffer.byteLength(value.replacementText, 'ascii') > MAX_TEXT_BYTES
    || !/^[\x20-\x7e]+$/u.test(value.replacementText)
    || /[\\()]/u.test(value.replacementText)
    || value.replacementText.trim() !== value.replacementText
    || /\s{2,}/u.test(value.replacementText)) return false;
  return true;
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
  if (!exact(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
  ]) || operation.schemaVersion !== 1 || !UUID.test(operation.id ?? '')
    || operation.type !== 'pdf-text-reflow' || !dense(operation.inputs, 1, 1)
    || !exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    || operation.inputs[0].documentId !== documentId || operation.inputs[0].sha256 !== sourceSha256
    || operation.inputs[0].role !== 'source'
    || !exact(operation.parameters, [
      'profile', 'page', 'streamReference', 'lineCount', 'lineWidth',
      'originalTextSha256', 'replacementTextSha256',
    ]) || operation.parameters.profile !== PDF_TEXT_REFLOW_PROFILE
    || operation.parameters.page !== request.page || operation.parameters.lineWidth !== request.lineWidth
    || operation.parameters.originalTextSha256 !== request.originalTextSha256
    || !SHA256.test(operation.parameters.replacementTextSha256 ?? '')
    || !exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'streamByteLengthPreserved', 'changedObjectCount'])
    || operation.expected.outputSha256 !== outputSha256 || operation.expected.sourcePrefixPreserved !== true
    || operation.expected.streamByteLengthPreserved !== true || operation.expected.changedObjectCount !== 1
    || !exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    || operation.validation.passed !== true || operation.validation.outputSha256 !== outputSha256
    || !dense(operation.validation.validators, 1, 64)
    || !operation.validation.validators.includes('independent-text-reflow-reinspection')
    || !canonicalTimestamp(operation.completedAt)) return false;
  return true;
}

function validArtifact(artifact, { documentId, sourceSha256, proof, request }) {
  if (!exact(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
  ]) || !OPAQUE_ID_PATTERN.test(artifact.id ?? '') || artifact.id === documentId
    || artifact.documentId !== documentId || artifact.displayName !== 'text-reflow.pdf'
    || artifact.mediaType !== 'application/pdf' || !Number.isSafeInteger(artifact.size)
    || artifact.size < 64 || artifact.size > 65 * 1024 * 1024 || !SHA256.test(artifact.sha256 ?? '')
    || artifact.sha256 === sourceSha256 || !canonicalTimestamp(artifact.createdAt)) return false;
  return validOperation(artifact.operation, {
    documentId, sourceSha256, outputSha256: artifact.sha256, request,
  }) && artifact.operation.parameters.streamReference === proof.streamReference;
}

function validProof(proof, { documentId, sourceSha256, request, outputSha256 }) {
  return exact(proof, [
    'profile', 'sourceSha256', 'outputSha256', 'sourcePrefixPreserved', 'page',
    'streamReference', 'lineCount', 'lineWidth', 'originalTextSha256',
    'replacementTextSha256', 'fixedSlotReflow', 'textPositionsPreserved',
    'typographyPreserved', 'streamByteLengthPreserved', 'revisionCount',
    'changedObjectCount',
  ]) && proof.profile === PDF_TEXT_REFLOW_PROFILE
    && proof.sourceSha256 === sourceSha256 && proof.outputSha256 === outputSha256
    && proof.sourcePrefixPreserved === true && proof.page === request.page
    && proof.lineWidth === request.lineWidth && proof.originalTextSha256 === request.originalTextSha256
    && SHA256.test(proof.replacementTextSha256 ?? '') && proof.fixedSlotReflow === true
    && proof.textPositionsPreserved === true && proof.typographyPreserved === true
    && proof.streamByteLengthPreserved === true && proof.lineCount === request.lineTokenIndices.length
    && Number.isSafeInteger(proof.revisionCount) && proof.revisionCount >= 2
    && proof.changedObjectCount === 1 && typeof documentId === 'string';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizeTextReflowRequest(value) {
  if (!validRequest(value)) throw new TypeError('Text-reflow request is invalid.');
  return deepFreeze({
    profile: PDF_TEXT_REFLOW_PROFILE,
    sourceSha256: value.sourceSha256,
    page: value.page,
    streamRef: deepFreeze({ ...value.streamRef }),
    lineTokenIndices: deepFreeze([...value.lineTokenIndices]),
    lineWidth: value.lineWidth,
    originalTextSha256: value.originalTextSha256,
    replacementText: value.replacementText,
  });
}

export function validateTextReflowResult(value, { documentId, sourceSha256, request } = {}) {
  const normalizedRequest = normalizeTextReflowRequest(request);
  if (!exact(value, ['kind', 'artifact', 'proof', 'limitations']) || value.kind !== 'pdf-text-reflow'
    || !Array.isArray(value.limitations) || value.limitations.length < 1
    || value.limitations.some((item) => typeof item !== 'string' || item.length < 1)) {
    throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid text-reflow result.');
  }
  const outputSha256 = value.artifact?.sha256;
  if (!validProof(value.proof, { documentId, sourceSha256, request: normalizedRequest, outputSha256 })
    || !validArtifact(value.artifact, {
      documentId, sourceSha256, proof: value.proof, request: normalizedRequest,
    })) {
    throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid retained text-reflow artifact.');
  }
  return deepFreeze({
    kind: value.kind,
    artifact: { ...value.artifact },
    proof: { ...value.proof },
    limitations: [...value.limitations],
  });
}

export function createTextReflowEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Text-reflow endpoints require a JSON transport.');
  function reflowText(documentId, sourceSha256, request, options = {}) {
      let candidate;
      try {
        candidate = { ...request, profile: PDF_TEXT_REFLOW_PROFILE, sourceSha256 };
      } catch {
        throw new TypeError('Text-reflow options are invalid.');
      }
      const signalDescriptor = options && typeof options === 'object' && !Array.isArray(options)
        ? Object.getOwnPropertyDescriptor(options, 'signal') : undefined;
      const optionKeys = signalDescriptor ? ['signal'] : [];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validRequest(candidate)
        || !exact(options, optionKeys)
        || (signalDescriptor && options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Text-reflow options are invalid.');
      }
      const normalized = normalizeTextReflowRequest(candidate);
      return json(`/api/documents/${encodeURIComponent(documentId)}/text-reflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized),
        signal: signalDescriptor ? options.signal : undefined,
      }).then((body) => validateTextReflowResult(body?.result, {
        documentId, sourceSha256, request: normalized,
      }));
  }
  return Object.freeze({ reflowText, textReflow: reflowText });
}
