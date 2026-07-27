import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const PROFILE = 'local-pdf-jpeg-image-replacement-v1';
const RESULT_KEYS = ['kind', 'sourceDigest', 'artifact', 'page', 'resourceName', 'targetReference', 'replacementImage', 'invocation', 'evidence', 'limitations'];
const ARTIFACT_KEYS = ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'];
const IMAGE_KEYS = ['width', 'height', 'components', 'bytes', 'sha256'];
const INVOCATION_KEYS = ['contentReference', 'ctm'];
const EVIDENCE_KEYS = ['sourcePrefixPreserved', 'contentPreserved', 'resourceIdentityPreserved', 'objectIdentityPreserved', 'outputDigestBound', 'sourceUnchanged', 'localOnly'];

function descriptors(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function dataObject(value, keys) {
  const fields = descriptors(value);
  if (!fields || Object.keys(fields).length !== keys.length || Object.keys(fields).some((key) => !keys.includes(key))) return false;
  return Object.values(fields).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}

function plainData(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.keys(fields).some((key) => key !== 'length' && !/^\d+$/u.test(key))) return false;
      if (!Object.hasOwn(fields.length, 'value') || fields.length.enumerable) return false;
    } else if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const [key, descriptor] of Object.entries(fields)) {
      if (key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true || !plainData(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function validOperation(value) {
  return dataObject(value, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && plainData(value)
    && value.schemaVersion === 1
    && OPAQUE_ID_PATTERN.test(value.id ?? '')
    && value.type === 'pdf-jpeg-image-replacement'
    && Array.isArray(value.inputs)
    && value.inputs.length === 1
    && dataObject(value.inputs[0], ['documentId', 'sha256', 'role'])
    && OPAQUE_ID_PATTERN.test(value.inputs[0].documentId ?? '')
    && SHA256.test(value.inputs[0].sha256 ?? '')
    && value.inputs[0].role === 'source'
    && dataObject(value.validation, ['passed', 'validators', 'outputSha256'])
    && value.validation.passed === true
    && Array.isArray(value.validation.validators)
    && value.validation.validators.length > 0
    && SHA256.test(value.validation.outputSha256 ?? '')
    && typeof value.completedAt === 'string'
    && !Number.isNaN(Date.parse(value.completedAt));
}

function result(body) {
  if (!dataObject(body, ['result']) || !plainData(body)) throw new TypeError('JPEG replacement result is invalid.');
  const value = body.result;
  if (!dataObject(value, RESULT_KEYS)
    || value.kind !== 'pdf-jpeg-image-replacement'
    || !SHA256.test(value.sourceDigest ?? '')
    || !dataObject(value.artifact, ARTIFACT_KEYS)
    || !OPAQUE_ID_PATTERN.test(value.artifact.id ?? '')
    || !OPAQUE_ID_PATTERN.test(value.artifact.documentId ?? '')
    || value.artifact.displayName !== 'jpeg-image-replacement.pdf'
    || value.artifact.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(value.artifact.size)
    || value.artifact.size < 64
    || !SHA256.test(value.artifact.sha256 ?? '')
    || !validOperation(value.artifact.operation)
    || typeof value.artifact.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.artifact.createdAt))
    || !Number.isSafeInteger(value.page)
    || value.page < 1
    || typeof value.resourceName !== 'string'
    || !/^[A-Za-z0-9_.-]{1,127}$/u.test(value.resourceName)
    || !/^\d+ \d+ R$/u.test(value.targetReference ?? '')
    || !dataObject(value.replacementImage, IMAGE_KEYS)
    || !Number.isSafeInteger(value.replacementImage.width)
    || value.replacementImage.width < 1
    || !Number.isSafeInteger(value.replacementImage.height)
    || value.replacementImage.height < 1
    || !Number.isSafeInteger(value.replacementImage.components)
    || ![1, 3].includes(value.replacementImage.components)
    || !Number.isSafeInteger(value.replacementImage.bytes)
    || value.replacementImage.bytes < 1
    || !SHA256.test(value.replacementImage.sha256 ?? '')
    || !dataObject(value.invocation, INVOCATION_KEYS)
    || !/^\d+ \d+ R$/u.test(value.invocation.contentReference ?? '')
    || !Array.isArray(value.invocation.ctm)
    || value.invocation.ctm.length !== 6
    || value.invocation.ctm.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
    || !dataObject(value.evidence, EVIDENCE_KEYS)
    || Object.values(value.evidence).some((entry) => entry !== true)
    || !Array.isArray(value.limitations)
    || value.limitations.length < 1
    || value.limitations.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 512)) {
    throw new TypeError('JPEG replacement result is invalid.');
  }
  return value;
}

export function createJpegImageReplacementEndpoints({ json }) {
  return Object.freeze({
    replaceJpegImage(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '')
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
        || !exactObject(request, ['profile', 'sourceSha256', 'inputId', 'inputSha256', 'page', 'resourceName'])
        || request.profile !== PROFILE
        || !SHA256.test(request.sourceSha256 ?? '')
        || !OPAQUE_ID_PATTERN.test(request.inputId ?? '')
        || !SHA256.test(request.inputSha256 ?? '')
        || !Number.isSafeInteger(request.page)
        || request.page < 1
        || typeof request.resourceName !== 'string'
        || !/^[A-Za-z0-9_.-]{1,127}$/u.test(request.resourceName)) {
        throw new TypeError('JPEG replacement options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/replace-jpeg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: options.signal,
      }).then(result);
    },
  });
}

export { result as validateJpegImageReplacementResult };
