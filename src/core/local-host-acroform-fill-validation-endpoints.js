import { isProxy } from 'node:util/types';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_ACROFORM_FILL_SAVE_PROFILE = 'local-acroform-fill-save-v1';
export const PDF_ACROFORM_VALIDATION_PROFILE = 'local-acroform-validation-v1';
export const PDF_ACROFORM_FILL_SAVE_KIND = 'pdf-acroform-fill-save';
export const PDF_ACROFORM_VALIDATION_KIND = 'pdf-acroform-validation';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FIELD_TYPES = new Set(['text', 'choice', 'checkbox', 'radio']);
const VALIDATION_CODES = new Set(['REQUIRED', 'TYPE', 'MIN_LENGTH', 'MAX_LENGTH']);
const FILL_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'bounded-acroform-fill-save-core',
  'independent-fill-save-reinspection', 'output-sha256',
]);
const FILL_LIMITATIONS = Object.freeze([
  'Exactly one existing terminal text, choice, canonical checkbox, or canonical radio field is updated in a separate incremental derived PDF.',
  'No appearance regeneration, flattening, calculations, interchange, XFA, signature preservation, or byte-preservation claim is made.',
]);
const VALIDATION_LIMITATIONS = Object.freeze([
  'Read-only validation for up to 100 existing terminal classic AcroForm fields.',
  'No regex rules, mutation, artifact creation, calculations, XFA, actions, JavaScript, signatures, or unsupported PDF graphs are supported.',
]);

function plain(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every((key) => typeof key === 'string')
      && Object.values(descriptors).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
  } catch {
    return false;
  }
}

function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function dense(value, minimum = 0, maximum = 100) {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.hasOwn(descriptors.length, 'value') && descriptors.length.enumerable === false
      && Array.from({ length: value.length }, (_, index) => descriptors[index])
        .every((descriptor) => descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
  } catch {
    return false;
  }
}

function text(value, minimum = 1, maximum = 127) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value !== value.normalize('NFC')
    || /[\u0000-\u001f\u007f\ufffd\p{Cf}]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function signalOptions(options) {
  if (!plain(options)) throw new TypeError('AcroForm fill/validation options are invalid.');
  const keys = Object.hasOwn(options, 'signal') ? ['signal'] : [];
  if (!exact(options, keys)
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError('AcroForm fill/validation options are invalid.');
  }
  return options.signal;
}

function copyProperty(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function snapshotFillRequest(request) {
  if (!exact(request, ['profile', 'sourceSha256', 'fieldName', 'value'])
    || request.profile !== PDF_ACROFORM_FILL_SAVE_PROFILE || !SHA256.test(request.sourceSha256 ?? '')
    || !text(request.fieldName) || (typeof request.value !== 'string' && typeof request.value !== 'boolean')
    || (typeof request.value === 'string' && !text(request.value, 0, 2000))) {
    throw new TypeError('AcroForm fill/save request is invalid.');
  }
  const copy = {};
  for (const key of ['profile', 'sourceSha256', 'fieldName', 'value']) copyProperty(copy, key, request[key]);
  return Object.freeze(copy);
}

function snapshotValidationRequest(request) {
  if (!exact(request, ['profile', 'sourceSha256', 'values', 'rules'])
    || request.profile !== PDF_ACROFORM_VALIDATION_PROFILE || !SHA256.test(request.sourceSha256 ?? '')
    || !plain(request.values) || !plain(request.rules)) throw new TypeError('AcroForm validation request is invalid.');
  const valueNames = Object.keys(request.values);
  const ruleNames = Object.keys(request.rules);
  if (valueNames.length > 100 || ruleNames.some((name) => !Object.hasOwn(request.values, name))) {
    throw new TypeError('AcroForm validation fields are outside the bounded subset.');
  }
  const values = {};
  for (const name of valueNames) {
    if (!text(name) || (typeof request.values[name] !== 'string' && typeof request.values[name] !== 'boolean')) {
      throw new TypeError('AcroForm validation values are invalid.');
    }
    copyProperty(values, name, request.values[name]);
  }
  const rules = {};
  for (const name of ruleNames) {
    const rule = request.rules[name];
    if (!plain(rule) || Object.keys(rule).some((key) => !['required', 'type', 'minLength', 'maxLength'].includes(key))) {
      throw new TypeError('AcroForm validation rules are invalid.');
    }
    if (rule.required !== undefined && typeof rule.required !== 'boolean') throw new TypeError('AcroForm validation rules are invalid.');
    if (rule.type !== undefined && !['string', 'boolean'].includes(rule.type)) throw new TypeError('AcroForm validation rules are invalid.');
    for (const key of ['minLength', 'maxLength']) {
      if (rule[key] !== undefined && (!Number.isSafeInteger(rule[key]) || rule[key] < 0 || rule[key] > 2000)) throw new TypeError('AcroForm validation rules are invalid.');
    }
    if (rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) throw new TypeError('AcroForm validation rules are invalid.');
    const ruleCopy = {};
    for (const key of Object.keys(rule)) copyProperty(ruleCopy, key, rule[key]);
    copyProperty(rules, name, Object.freeze(ruleCopy));
  }
  const copy = {};
  copyProperty(copy, 'profile', request.profile);
  copyProperty(copy, 'sourceSha256', request.sourceSha256);
  copyProperty(copy, 'values', Object.freeze(values));
  copyProperty(copy, 'rules', Object.freeze(rules));
  return Object.freeze(copy);
}

function reference(value) {
  return exact(value, ['object', 'generation']) && Number.isSafeInteger(value.object) && value.object > 0
    && Number.isSafeInteger(value.generation) && value.generation >= 0;
}

function artifact(value, documentId, sourceSha256) {
  return exact(value, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(value.id ?? '') && value.id !== documentId && value.documentId === documentId
    && value.displayName === 'filled-form.pdf' && value.mediaType === 'application/pdf'
    && Number.isSafeInteger(value.size) && value.size > 0 && SHA256.test(value.sha256 ?? '') && value.sha256 !== sourceSha256
    && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt));
}

function validFillResult(result, context) {
  if (!exact(result, ['kind', 'artifact', 'proof', 'limitations']) || result.kind !== PDF_ACROFORM_FILL_SAVE_KIND
    || !artifact(result.artifact, context.documentId, context.sourceSha256)
    || !exact(result.proof, ['profile', 'sourceSha256', 'fieldNameSha256', 'valueSha256', 'fieldType', 'widgetReference', 'sourcePrefixPreserved', 'semanticValueValidated', 'revisionCount'])
    || result.proof.profile !== PDF_ACROFORM_FILL_SAVE_PROFILE || result.proof.sourceSha256 !== context.sourceSha256
    || !SHA256.test(result.proof.fieldNameSha256 ?? '') || !SHA256.test(result.proof.valueSha256 ?? '')
    || !FIELD_TYPES.has(result.proof.fieldType) || !reference(result.proof.widgetReference)
    || result.proof.sourcePrefixPreserved !== true || result.proof.semanticValueValidated !== true
    || !Number.isSafeInteger(result.proof.revisionCount) || result.proof.revisionCount < 1 || result.proof.revisionCount > 1_000_000
    || !dense(result.limitations, FILL_LIMITATIONS.length, FILL_LIMITATIONS.length)
    || JSON.stringify(result.limitations) !== JSON.stringify(FILL_LIMITATIONS)) return false;
  const operation = result.artifact.operation;
  return exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && UUID.test(operation.id ?? '') && operation.type === 'pdf-acroform-fill-save'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && dense(operation.inputs, 1, 1) && exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exact(operation.parameters, ['profile', 'fieldNameSha256', 'valueSha256', 'fieldType', 'widgetReference'])
    && operation.parameters.profile === PDF_ACROFORM_FILL_SAVE_PROFILE
    && operation.parameters.fieldNameSha256 === result.proof.fieldNameSha256 && operation.parameters.valueSha256 === result.proof.valueSha256
    && operation.parameters.fieldType === result.proof.fieldType && JSON.stringify(operation.parameters.widgetReference) === JSON.stringify(result.proof.widgetReference)
    && exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'signaturePreservation'])
    && operation.expected.outputSha256 === result.artifact.sha256 && operation.expected.sourcePrefixPreserved === true && operation.expected.signaturePreservation === false
    && exact(operation.validation, ['passed', 'validators', 'outputSha256']) && operation.validation.passed === true
    && dense(operation.validation.validators, FILL_VALIDATORS.length, FILL_VALIDATORS.length)
    && JSON.stringify(operation.validation.validators) === JSON.stringify(FILL_VALIDATORS)
    && operation.validation.outputSha256 === result.artifact.sha256;
}

function validValidationResult(result, context) {
  return exact(result, ['kind', 'sourceDigest', 'fieldCount', 'valid', 'errors', 'limitations', 'localOnly'])
    && result.kind === PDF_ACROFORM_VALIDATION_KIND && result.sourceDigest === context.sourceSha256
    && Number.isSafeInteger(result.fieldCount) && result.fieldCount >= 1 && result.fieldCount <= 100
    && typeof result.valid === 'boolean' && dense(result.errors, 0, result.fieldCount)
    && result.errors.every((error) => exact(error, ['fieldNameSha256', 'code']) && SHA256.test(error.fieldNameSha256 ?? '') && VALIDATION_CODES.has(error.code))
    && new Set(result.errors.map((error) => error.fieldNameSha256)).size === result.errors.length
    && result.valid === (result.errors.length === 0)
    && dense(result.limitations, VALIDATION_LIMITATIONS.length, VALIDATION_LIMITATIONS.length)
    && JSON.stringify(result.limitations) === JSON.stringify(VALIDATION_LIMITATIONS) && result.localOnly === true;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validatedResult(result, valid, message) {
  if (!valid) throw new TypeError(message);
  let clone;
  try { clone = structuredClone(result); } catch { throw new TypeError(message); }
  return deepFreeze(clone);
}

export function validateAcroFormFillSaveResult(result, context) {
  if (!OPAQUE_ID_PATTERN.test(context?.documentId ?? '') || !SHA256.test(context?.sourceSha256 ?? '')) throw new TypeError('AcroForm fill/save context is invalid.');
  return validatedResult(result, validFillResult(result, context), 'The local host returned an invalid AcroForm fill/save result.');
}

export function validateAcroFormValidationResult(result, context) {
  if (!OPAQUE_ID_PATTERN.test(context?.documentId ?? '') || !SHA256.test(context?.sourceSha256 ?? '')) throw new TypeError('AcroForm validation context is invalid.');
  return validatedResult(result, validValidationResult(result, context), 'The local host returned an invalid AcroForm validation result.');
}

export function createAcroFormFillValidationEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('AcroForm fill/validation endpoints require JSON transport.');
  function fillAndSaveAcroForm(documentId, request, options = {}) {
    const signal = signalOptions(options); const fixed = snapshotFillRequest(request);
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '')) throw new TypeError('AcroForm fill/save document id is invalid.');
    return postJson(json, documentEndpointPath(documentId, '/acroform-fill-save'), fixed, signal)
      .then((body) => validateAcroFormFillSaveResult(body?.result, { documentId, sourceSha256: fixed.sourceSha256 }));
  }
  function validateAcroFormValues(documentId, request, options = {}) {
    const signal = signalOptions(options); const fixed = snapshotValidationRequest(request);
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '')) throw new TypeError('AcroForm validation document id is invalid.');
    return postJson(json, documentEndpointPath(documentId, '/acroform-validate'), fixed, signal)
      .then((body) => validateAcroFormValidationResult(body?.result, { documentId, sourceSha256: fixed.sourceSha256 }));
  }
  return Object.freeze({ fillAndSaveAcroForm, validateAcroFormValues });
}
