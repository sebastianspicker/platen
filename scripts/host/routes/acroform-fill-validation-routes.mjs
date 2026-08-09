import { HostError } from '../host-error.mjs';
import { isProxy } from 'node:util/types';
import { PDF_ACROFORM_FILL_SAVE_PROFILE } from '../pdf-acroform-fill-save-writer.mjs';
import { PDF_ACROFORM_VALIDATION_PROFILE } from '../pdf-acroform-validation-service.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ARTIFACT_KEYS = Object.freeze(['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']);
const OPERATION_KEYS = Object.freeze(['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt']);
const FILL_PROOF_KEYS = Object.freeze(['profile', 'sourceSha256', 'fieldNameSha256', 'valueSha256', 'fieldType', 'widgetReference', 'sourcePrefixPreserved', 'semanticValueValidated', 'revisionCount']);
const FILL_VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'bounded-acroform-fill-save-core', 'independent-fill-save-reinspection', 'output-sha256']);
const VALIDATION_ERROR_CODES = new Set(['REQUIRED', 'TYPE', 'MIN_LENGTH', 'MAX_LENGTH']);

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function plainExact(value, keys) {
  return exact(value, keys) && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function boundedText(value, maximum = 127, minimum = 1) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && value === value.normalize('NFC')
    && !/[\u0000-\u001f\u007f\ufffd\p{Cf}\p{Cs}]/u.test(value);
}

function validFillBody(body) {
  return plainExact(body, ['profile', 'sourceSha256', 'fieldName', 'value'])
    && body.profile === PDF_ACROFORM_FILL_SAVE_PROFILE
    && SHA256.test(body.sourceSha256 ?? '')
    && boundedText(body.fieldName)
    && (typeof body.value === 'string' ? boundedText(body.value, 2000, 0) : typeof body.value === 'boolean');
}

function validValidationBody(body) {
  if (!plainExact(body, ['profile', 'sourceSha256', 'values', 'rules'])
    || body.profile !== PDF_ACROFORM_VALIDATION_PROFILE || !SHA256.test(body.sourceSha256 ?? '')
    || !plainExact(body.values, Object.keys(body.values ?? {}))
    || !plainExact(body.rules, Object.keys(body.rules ?? {}))
    || Object.keys(body.values).length > 100) return false;
  const names = Object.keys(body.values);
  if (names.some((name) => !boundedText(name))) return false;
  if (Object.keys(body.rules).some((name) => !Object.hasOwn(body.values, name) || !boundedText(name))) return false;
  for (const name of names) {
    const value = body.values[name];
    if (typeof value !== 'string' && typeof value !== 'boolean') return false;
    const rule = body.rules[name] ?? {};
    if (!plainExact(rule, Object.keys(rule)) || Object.keys(rule).some((key) => !['required', 'type', 'minLength', 'maxLength'].includes(key))) return false;
    if (Object.hasOwn(rule, 'required') && typeof rule.required !== 'boolean') return false;
    if (Object.hasOwn(rule, 'type') && !['string', 'boolean'].includes(rule.type)) return false;
    for (const key of ['minLength', 'maxLength']) {
      if (Object.hasOwn(rule, key) && (!Number.isSafeInteger(rule[key]) || rule[key] < 0 || rule[key] > 2000)) return false;
    }
    if (rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) return false;
  }
  return true;
}

function validOperation(operation, { documentId, sourceSha256, outputSha256, proof, profile }) {
  if (!exact(operation, OPERATION_KEYS) || operation.schemaVersion !== 1 || !UUID.test(operation.id ?? '')
    || operation.type !== 'pdf-acroform-fill-save' || !Array.isArray(operation.inputs) || operation.inputs.length !== 1
    || !exact(operation.inputs[0], ['documentId', 'sha256', 'role']) || operation.inputs[0].documentId !== documentId
    || operation.inputs[0].sha256 !== sourceSha256 || operation.inputs[0].role !== 'source'
    || !exact(operation.parameters, ['profile', 'fieldNameSha256', 'valueSha256', 'fieldType', 'widgetReference'])
    || operation.parameters.profile !== profile || operation.parameters.fieldNameSha256 !== proof.fieldNameSha256
    || operation.parameters.valueSha256 !== proof.valueSha256 || operation.parameters.fieldType !== proof.fieldType
    || JSON.stringify(operation.parameters.widgetReference) !== JSON.stringify(proof.widgetReference)
    || !exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'signaturePreservation'])
    || operation.expected.outputSha256 !== outputSha256 || operation.expected.sourcePrefixPreserved !== true
    || operation.expected.signaturePreservation !== false
    || !exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    || operation.validation.passed !== true || operation.validation.outputSha256 !== outputSha256
    || !Array.isArray(operation.validation.validators) || JSON.stringify(operation.validation.validators) !== JSON.stringify(FILL_VALIDATORS)
    || !canonicalTimestamp(operation.completedAt)) return false;
  return true;
}

function validFillResult(result, { documentId, sourceSha256, request }) {
  if (!exact(result, ['kind', 'artifact', 'proof', 'limitations']) || result.kind !== 'pdf-acroform-fill-save'
    || !Array.isArray(result.limitations) || result.limitations.length < 1
    || result.limitations.some((item) => typeof item !== 'string' || item.length < 1)
    || !exact(result.proof, FILL_PROOF_KEYS) || result.proof.profile !== request.profile
    || result.proof.sourceSha256 !== sourceSha256 || !SHA256.test(result.proof.fieldNameSha256 ?? '')
    || !SHA256.test(result.proof.valueSha256 ?? '') || !['text', 'choice', 'checkbox', 'radio'].includes(result.proof.fieldType)
    || !exact(result.proof.widgetReference, ['object', 'generation'])
    || !Number.isSafeInteger(result.proof.widgetReference.object) || result.proof.widgetReference.object < 1
    || !Number.isSafeInteger(result.proof.widgetReference.generation) || result.proof.widgetReference.generation < 0
    || result.proof.sourcePrefixPreserved !== true || result.proof.semanticValueValidated !== true
    || !Number.isSafeInteger(result.proof.revisionCount) || result.proof.revisionCount < 2) return false;
  const artifact = result.artifact;
  return exact(artifact, ARTIFACT_KEYS) && UUID.test(artifact.id ?? '') && artifact.id !== documentId
    && artifact.documentId === documentId && artifact.displayName === 'filled-form.pdf' && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 33 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256 && canonicalTimestamp(artifact.createdAt)
    && validOperation(artifact.operation, { documentId, sourceSha256, outputSha256: artifact.sha256, proof: result.proof, profile: request.profile });
}

function cloneFillResult(result) {
  return Object.freeze({
    kind: result.kind,
    artifact: Object.freeze({
      id: result.artifact.id, documentId: result.artifact.documentId, displayName: result.artifact.displayName,
      mediaType: result.artifact.mediaType, size: result.artifact.size, sha256: result.artifact.sha256,
      operation: freezeCopy(result.artifact.operation), createdAt: result.artifact.createdAt,
    }),
    proof: freezeCopy(result.proof),
    limitations: Object.freeze([...result.limitations]),
  });
}

function freezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeCopy(child)])));
  }
  return value;
}

function validValidationResult(result, sourceSha256) {
  return exact(result, ['kind', 'sourceDigest', 'fieldCount', 'valid', 'errors', 'limitations', 'localOnly'])
    && result.kind === 'pdf-acroform-validation' && result.sourceDigest === sourceSha256
    && Number.isSafeInteger(result.fieldCount) && result.fieldCount >= 1 && result.fieldCount <= 100
    && typeof result.valid === 'boolean' && Array.isArray(result.errors) && result.errors.length <= result.fieldCount
    && result.errors.every((error) => exact(error, ['fieldNameSha256', 'code']) && SHA256.test(error.fieldNameSha256 ?? '') && VALIDATION_ERROR_CODES.has(error.code))
    && result.valid === (result.errors.length === 0) && Array.isArray(result.limitations) && result.limitations.length > 0
    && result.limitations.every((item) => typeof item === 'string' && item.length > 0) && result.localOnly === true;
}

function cloneValidationResult(result) {
  return Object.freeze({
    kind: result.kind, sourceDigest: result.sourceDigest, fieldCount: result.fieldCount, valid: result.valid,
    errors: Object.freeze(result.errors.map((error) => Object.freeze({ fieldNameSha256: error.fieldNameSha256, code: error.code }))),
    limitations: Object.freeze([...result.limitations]), localOnly: true,
  });
}

async function cleanupUntrustedArtifact(store, result, documentId, sourceSha256) {
  const returned = result?.artifact;
  if (typeof returned?.id !== 'string' || typeof store?.getArtifact !== 'function' || typeof store.deleteArtifact !== 'function') return;
  let retained;
  try { retained = await store.getArtifact(returned.id); } catch { return; }
  const input = retained?.operation?.inputs?.length === 1 ? retained.operation.inputs[0] : null;
  if (!retained || retained.id !== returned.id || retained.documentId !== documentId || input?.documentId !== documentId
    || input.sha256 !== sourceSha256 || retained.operation?.type !== 'pdf-acroform-fill-save'
    || retained.operation?.validation?.outputSha256 !== retained.sha256) return;
  await store.deleteArtifact(retained.id).catch(() => {});
}

export async function handleAcroFormFillValidationRoute(context) {
  if (context.operation !== 'acroform-fill-save' && context.operation !== 'acroform-validate') return false;
  const { request, response, url, documentId, processing, store, acroFormFillSave, acroFormValidation, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'AcroForm fill/save and validation routes do not accept query parameters.', 400);
  const fill = context.operation === 'acroform-fill-save';
  const service = fill ? acroFormFillSave : acroFormValidation;
  const methodName = fill ? 'fill' : 'validate';
  if (!service || typeof service[methodName] !== 'function') throw new HostError(fill ? 'ACROFORM_FILL_SAVE_UNAVAILABLE' : 'ACROFORM_VALIDATION_UNAVAILABLE', 'The local AcroForm service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  let valid = false;
  try {
    valid = fill ? validFillBody(body) : validValidationBody(body);
    if (valid && exactJsonObject) valid = exactJsonObject(body, fill ? ['profile', 'sourceSha256', 'fieldName', 'value'] : ['profile', 'sourceSha256', 'values', 'rules']);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new HostError(fill ? 'INVALID_ACROFORM_FILL_SAVE_OPTIONS' : 'INVALID_ACROFORM_VALIDATION_OPTIONS', 'The AcroForm request is invalid.', 400);
  }
  let source;
  try { source = store.getDocument(documentId); } catch (error) {
    throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'The AcroForm source document is unavailable.', 404, { cause: error });
  }
  if (source.sha256 !== body.sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'The AcroForm source digest does not match the current document.', 409);
  const result = await service[methodName](documentId, body, { signal: processing.signal });
  if (processing.signal.aborted || response.destroyed) {
    if (fill && result?.artifact?.id) await store.deleteArtifact(result.artifact.id).catch(() => {});
    return true;
  }
  if (fill) {
    let validResult = false;
    try { validResult = validFillResult(result, { documentId, sourceSha256: body.sourceSha256, request: body }); } catch { validResult = false; }
    if (!validResult) {
      await cleanupUntrustedArtifact(store, result, documentId, body.sourceSha256);
      throw new HostError('ACROFORM_FILL_SAVE_RESULT_INVALID', 'The AcroForm fill/save service returned invalid evidence.', 502);
    }
    const checked = cloneFillResult(result);
    if (await scheduleArtifactCleanup({ processing, response, store }, checked.artifact.id)) return true;
    json(response, 201, { result: checked });
  } else {
    let validResult = false;
    try { validResult = validValidationResult(result, body.sourceSha256); } catch { validResult = false; }
    if (!validResult) throw new HostError('ACROFORM_VALIDATION_RESULT_INVALID', 'The AcroForm validation service returned invalid evidence.', 502);
    json(response, 200, { result: cloneValidationResult(result) });
  }
  return true;
}

export { validFillResult as validateAcroFormFillSaveResult, validValidationResult as validateAcroFormValidationResult };
