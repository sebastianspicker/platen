import { exactObject, OPAQUE_ID_PATTERN, validPdfKitRectangle } from './pdfkit-client-contract-shared.js';

const PROFILE = 'local-pdf-acroform-choice-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'bounded-acroform-choice-core', 'independent-choice-reinspection', 'output-sha256']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}
function plainArray(value, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return descriptors.length.enumerable === false && !descriptors.length.get && !descriptors.length.set
    && Object.keys(descriptors).filter((key) => key !== 'length').every((key) => Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}
function text(value) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value.length < 1 || value.length > 127 || /[\u0000-\u001f\u007f\ufffd\p{Cf}]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index); const next = value.charCodeAt(index + 1);
    if ((code >= 0xd800 && code <= 0xdbff) && !(next >= 0xdc00 && next <= 0xdfff)) return false;
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function limitation(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 512 && /^[\x20-\x7E]*$/u.test(value); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
function validRef(value) { return exact(value, ['object', 'generation']) && Number.isSafeInteger(value.object) && value.object > 0 && Number.isSafeInteger(value.generation) && value.generation >= 0; }
function validateResult(body, context) {
  const result = body?.result; const proof = result?.proof; const operation = result?.artifact?.operation;
  const validOperation = exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt']) && operation.schemaVersion === 1 && UUID.test(operation.id ?? '') && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt)) && operation.type === 'pdf-acroform-choice' && Array.isArray(operation.inputs) && operation.inputs.length === 1 && exact(operation.inputs[0], ['documentId', 'sha256', 'role']) && operation.inputs[0].documentId === context.documentId && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exact(operation.parameters, ['profile', 'page', 'fieldNameSha256', 'optionLabelSha256', 'optionCount']) && operation.parameters.profile === PROFILE && operation.parameters.page === context.request.page && operation.parameters.fieldNameSha256 === proof?.fieldNameSha256 && operation.parameters.optionCount === context.request.options.length && JSON.stringify(operation.parameters.optionLabelSha256) === JSON.stringify(proof?.optionLabelSha256)
    && exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'unchecked']) && operation.expected.outputSha256 === result?.artifact?.sha256 && operation.expected.sourcePrefixPreserved === true && operation.expected.unchecked === true && exact(operation.validation, ['passed', 'validators', 'outputSha256']) && operation.validation.passed === true && JSON.stringify(operation.validation.validators) === JSON.stringify(VALIDATORS) && operation.validation.outputSha256 === result?.artifact?.sha256;
  const validResult = exact(result, ['artifact', 'proof', 'limitations']) && exact(result.artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']) && OPAQUE_ID_PATTERN.test(result.artifact.id ?? '') && result.artifact.id !== context.documentId && result.artifact.documentId === context.documentId && typeof result.artifact.createdAt === 'string' && !Number.isNaN(Date.parse(result.artifact.createdAt)) && result.artifact.displayName === 'choice-form.pdf' && result.artifact.mediaType === 'application/pdf' && Number.isSafeInteger(result.artifact.size) && result.artifact.size > 0 && SHA256.test(result.artifact.sha256 ?? '') && result.artifact.sha256 !== context.sourceSha256 && validOperation;
  const validProofShape = exact(proof, ['profile', 'sourceSha256', 'page', 'fieldNameSha256', 'optionLabelSha256', 'rect', 'options', 'combo', 'font', 'appearance', 'widget', 'acroForm', 'sourcePrefixPreserved', 'appearanceSha256']);
  const validProof = validProofShape && proof.profile === PROFILE && proof.sourceSha256 === context.sourceSha256 && proof.page === context.request.page && proof.combo === false && proof.sourcePrefixPreserved === true && SHA256.test(proof.fieldNameSha256 ?? '')
    && plainArray(proof.optionLabelSha256, 2, 50) && proof.optionLabelSha256.every((digest) => SHA256.test(digest)) && plainArray(proof.options, 2, 50)
    && proof.options.every((entry, index) => exact(entry, ['labelSha256']) && SHA256.test(entry.labelSha256 ?? '') && entry.labelSha256 === proof.optionLabelSha256[index])
    && exact(proof.rect, ['x', 'y', 'width', 'height']) && validPdfKitRectangle(proof.rect) && ['x', 'y', 'width', 'height'].every((key) => proof.rect[key] === context.request.rect[key])
    && ['font', 'appearance', 'widget', 'acroForm'].every((key) => validRef(proof[key])) && new Set(['font', 'appearance', 'widget', 'acroForm'].map((key) => `${proof[key].object}:${proof[key].generation}`)).size === 4 && SHA256.test(proof.appearanceSha256 ?? '');
  if (!validResult || !validProof || !plainArray(result.limitations, 1, 8) || result.limitations.some((entry) => !limitation(entry))) throw new TypeError('AcroForm choice result is invalid.');
  return freeze(result);
}
export function createAcroFormChoiceEndpoints({ json }) {
  return Object.freeze({
    addAcroFormChoice(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || !exact(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect', 'options']) || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 10_000 || !text(request.fieldName) || !validPdfKitRectangle(request.rect) || !plainArray(request.options, 2, 50) || request.options.some((entry) => !exact(entry, ['label']) || !text(entry.label)) || new Set(request.options.map((entry) => entry.label)).size !== request.options.length) throw new TypeError('AcroForm choice request is invalid.');
      const fixed = Object.freeze({ ...request, rect: Object.freeze({ ...request.rect }), options: Object.freeze(request.options.map((entry) => Object.freeze({ label: entry.label }))) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/acroform-choice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixed), signal: options.signal }).then((body) => validateResult(body, { documentId, sourceSha256: fixed.sourceSha256, request: fixed }));
    },
  });
}
