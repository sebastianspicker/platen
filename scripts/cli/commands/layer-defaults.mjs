import { basename } from 'node:path';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../../host/pdf-layer-defaults-contract.mjs';
import { PDF_LAYER_DEFAULTS_LIMITATIONS } from '../../host/pdf-layer-defaults-service.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESULT_KEYS = Object.freeze(['kind', 'sourceDigest', 'artifact', 'proof', 'evidence', 'limitations']);
const ARTIFACT_KEYS = Object.freeze(['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']);
const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved',
  'onlyCatalogChanged', 'revisionCount', 'groupCount', 'visible', 'catalogReference', 'outputSha256',
]);
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'onlyCatalogChanged',
  'classicIncrementalRevisionAppended', 'outputUnsigned', 'artifactDigestBound',
  'sourceUnchanged', 'localOnly',
]);

function fail(runtime, code, message) {
  if (typeof runtime.fail === 'function') runtime.fail(code, message);
  const error = new Error(message);
  error.code = code;
  throw error;
}

function snapshotRecord(value, runtime, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults result contains cyclic data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => key !== 'length' && (!/^\d+$/u.test(String(key))
        || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
        || descriptors[key].enumerable !== true))) {
        fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults result contains accessors or symbols.');
      }
      return Object.freeze(value.map((entry) => snapshotRecord(entry, runtime, seen)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults result contains a non-plain record.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')
      || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) {
      fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults result contains accessors or symbols.');
    }
    return Object.freeze(Object.fromEntries(Object.entries(descriptors)
      .map(([key, descriptor]) => [key, snapshotRecord(descriptor.value, runtime, seen)])));
  } finally {
    seen.delete(value);
  }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function sameValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Reflect.ownKeys(left); const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => rightKeys.includes(key) && sameValue(left[key], right[key]));
}

function validateResult(value, document, runtime) {
  const result = snapshotRecord(value, runtime);
  if (!exactKeys(result, RESULT_KEYS) || result.kind !== 'pdf-layer-defaults'
    || result.sourceDigest !== document.sha256 || !exactKeys(result.artifact, ARTIFACT_KEYS)
    || !exactKeys(result.proof, PROOF_KEYS) || !exactKeys(result.evidence, EVIDENCE_KEYS)
    || !Array.isArray(result.limitations) || result.limitations.length !== PDF_LAYER_DEFAULTS_LIMITATIONS.length
    || !result.limitations.every((entry, index) => entry === PDF_LAYER_DEFAULTS_LIMITATIONS[index])) {
    fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults service returned an invalid result.');
  }
  const artifact = result.artifact;
  if (!OPAQUE_ID.test(artifact.id ?? '') || artifact.documentId !== document.id
    || typeof artifact.displayName !== 'string' || artifact.displayName.length < 1
    || /[\u0000-\u001f\u007f]/u.test(artifact.displayName)
    || artifact.mediaType !== 'application/pdf' || !Number.isSafeInteger(artifact.size) || artifact.size < 64
    || !SHA256.test(artifact.sha256 ?? '') || artifact.sha256 === document.sha256
    || typeof artifact.createdAt !== 'string' || Number.isNaN(Date.parse(artifact.createdAt))
    || !artifact.operation || typeof artifact.operation !== 'object' || Array.isArray(artifact.operation)) {
    fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults artifact metadata is invalid.');
  }
  const proof = result.proof;
  if (proof.profile !== PDF_LAYER_DEFAULTS_PROFILE || !Number.isSafeInteger(proof.sourceBytes) || proof.sourceBytes < 5
    || !Number.isSafeInteger(proof.outputBytes) || proof.outputBytes <= proof.sourceBytes
    || proof.appendedBytes !== proof.outputBytes - proof.sourceBytes || proof.sourcePrefixPreserved !== true
    || proof.onlyCatalogChanged !== true || !Number.isSafeInteger(proof.revisionCount) || proof.revisionCount < 2
    || !Number.isSafeInteger(proof.groupCount) || proof.groupCount < 1 || proof.groupCount > 100
    || !Array.isArray(proof.visible) || proof.visible.length !== proof.groupCount
    || !proof.visible.every((entry) => typeof entry === 'boolean')
    || typeof proof.catalogReference !== 'string' || !/^\d+ \d+ R$/u.test(proof.catalogReference)
    || proof.outputSha256 !== artifact.sha256) {
    fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults proof is invalid.');
  }
  if (Object.values(result.evidence).some((entry) => entry !== true)) {
    fail(runtime, 'CLI_LAYER_DEFAULTS_RESULT_INVALID', 'The layer-defaults evidence is incomplete.');
  }
  return result;
}

function trustedArtifact(result, stored, document, runtime) {
  const artifact = snapshotRecord(stored, runtime);
  if (!exactKeys(artifact, [...ARTIFACT_KEYS, 'filePath'])
    || !sameValue(artifact.id, result.artifact.id)
    || !sameValue(artifact.documentId, document.id)
    || !sameValue(artifact.displayName, result.artifact.displayName)
    || !sameValue(artifact.mediaType, result.artifact.mediaType)
    || !sameValue(artifact.size, result.artifact.size)
    || !sameValue(artifact.sha256, result.artifact.sha256)
    || !sameValue(artifact.operation, result.artifact.operation)
    || !sameValue(artifact.createdAt, result.artifact.createdAt)
    || typeof artifact.filePath !== 'string' || artifact.filePath.length === 0) {
    fail(runtime, 'CLI_LAYER_DEFAULTS_ARTIFACT_INVALID', 'The layer-defaults artifact does not match the trusted store.');
  }
  return artifact;
}

function privacySafeReceipt(result, output) {
  return Object.freeze({
    kind: result.kind,
    artifact: Object.freeze({
      id: result.artifact.id,
      documentId: result.artifact.documentId,
      displayName: result.artifact.displayName,
      mediaType: result.artifact.mediaType,
      size: result.artifact.size,
      sha256: result.artifact.sha256,
      createdAt: result.artifact.createdAt,
      output: basename(output),
    }),
    proof: result.proof,
    evidence: result.evidence,
    limitations: result.limitations,
    localOnly: true,
  });
}

export async function runLayerDefaultsCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  if (!application?.layerDefaults || typeof application.layerDefaults.update !== 'function'
    || !application.store || typeof application.store.getArtifact !== 'function'
    || typeof application.store.deleteArtifact !== 'function') {
    fail(runtime, 'CLI_LAYER_DEFAULTS_UNAVAILABLE', 'Layer-defaults delivery is unavailable.');
  }
  let trustedArtifactId = null;
  let deletionAttempted = false;
  let operationError = null;
  let cleanupError = null;
  try {
    const serviceResult = await application.layerDefaults.update(
      document.id,
      { profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256: document.sha256, changes: command.changes },
      { sourceSha256: document.sha256, signal },
    );
    const result = validateResult(serviceResult, document, runtime);
    const artifact = trustedArtifact(result, application.store.getArtifact(result.artifact.id), document, runtime);
    trustedArtifactId = artifact.id;
    runtime.cancelled(signal);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    runtime.cancelled(signal);
    const receipt = privacySafeReceipt(result, command.output);
    deletionAttempted = true;
    await application.store.deleteArtifact(trustedArtifactId);
    await runtime.emit(stdout, receipt);
  } catch (error) {
    operationError = error;
  }
  if (trustedArtifactId && !deletionAttempted) {
    deletionAttempted = true;
    try { await application.store.deleteArtifact(trustedArtifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Layer-defaults delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}
