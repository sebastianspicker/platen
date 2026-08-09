import { createHash } from 'node:crypto';
import { HostError } from '../host-error.mjs';
import { PDF_ACROFORM_CHECKBOX_PROFILE } from '../pdf-acroform-checkbox-writer.mjs';
import { PDF_ACROFORM_RADIO_PROFILE } from '../pdf-acroform-radio-writer.mjs';
import { PDF_ACROFORM_TEXT_FIELD_PROFILE } from '../pdf-acroform-text-field-writer.mjs';
import { PDF_ACROFORM_CHOICE_PROFILE } from '../pdf-acroform-choice-writer.mjs';
import { PDF_ACROFORM_SIGNATURE_FIELD_PROFILE } from '../pdf-acroform-signature-field-writer.mjs';
import {
  normalizePdfAcroFormBarcodeRequest,
  PDF_ACROFORM_BARCODE_PROFILE,
} from '../pdf-acroform-barcode-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function validText(value) { return typeof value === 'string' && value === value.normalize('NFC') && [...value].length >= 1 && [...value].length <= 127 && Buffer.byteLength(value, 'utf8') <= 512 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value); }
function validRect(rect) { return rect && typeof rect === 'object' && !Array.isArray(rect) && Object.keys(rect).length === 4 && Object.keys(rect).every((key) => ['x', 'y', 'width', 'height'].includes(key)) && Object.values(rect).every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000) && rect.width > 0 && rect.height > 0; }
function validCanonicalRect(rect) { return validRect(rect) && Object.values(rect).every((value) => !Object.is(value, -0) && Math.round(value * 1_000_000) === value * 1_000_000); }
function validBase(body, profile, keys) { return SHA256.test(body?.sourceSha256 ?? '') && body?.profile === profile && Object.keys(body ?? {}).length === keys.length && Object.keys(body).every((key) => keys.includes(key)); }

async function handle({ kind, profile, request, response, url, documentId, operation, processing, store, service, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== `acroform-${kind}`) return false;
  const codeKind = kind.replaceAll('-', '_');
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', `AcroForm ${kind} does not accept query parameters.`, 400);
  if (!service) throw new HostError(`ACROFORM_${codeKind.toUpperCase()}_UNAVAILABLE`, `The AcroForm ${kind} service is unavailable.`, 503);
  const body = await readJson(request, bodyLimit);
  const keys = kind === 'radio' ? ['profile', 'sourceSha256', 'groupName', 'options'] : ['profile', 'sourceSha256', 'page', 'fieldName', 'rect', ...(kind === 'choice' ? ['options'] : [])];
  const valid = exactJsonObject(body, keys) && validBase(body, profile, keys) && (kind === 'checkbox' || kind === 'text-field' || kind === 'signature-field'
    ? Number.isSafeInteger(body.page) && body.page >= 1 && body.page <= 10000 && validText(body.fieldName) && (kind === 'signature-field' ? validCanonicalRect(body.rect) : validRect(body.rect))
    : kind === 'choice' ? Number.isSafeInteger(body.page) && body.page >= 1 && body.page <= 10000 && validText(body.fieldName) && validRect(body.rect) && Array.isArray(body.options) && body.options.length >= 2 && body.options.length <= 50 && body.options.every((entry) => exactJsonObject(entry, ['label']) && validText(entry.label)) && new Set(body.options.map((entry) => entry.label)).size === body.options.length
    : validText(body.groupName) && Array.isArray(body.options) && body.options.length >= 2 && body.options.length <= 10 && body.options.every((entry) => exactJsonObject(entry, ['label', 'page', 'rect']) && validText(entry.label) && Number.isSafeInteger(entry.page) && entry.page >= 1 && entry.page <= 10000 && validRect(entry.rect)) && new Set(body.options.map((entry) => entry.label)).size === body.options.length && new Set(body.options.map((entry) => `${entry.page}\u0000${entry.rect.x},${entry.rect.y},${entry.rect.width},${entry.rect.height}`)).size === body.options.length);
  if (!valid) throw new HostError(`INVALID_ACROFORM_${codeKind.toUpperCase()}_OPTIONS`, `The AcroForm ${kind} request is invalid.`, 400);
  const result = await service.add(documentId, body, { signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result }); return true;
}

export function handleAcroFormCheckboxRoute({ acroFormCheckbox, ...options }) { return handle({ ...options, service: acroFormCheckbox, kind: 'checkbox', profile: PDF_ACROFORM_CHECKBOX_PROFILE, bodyLimit: 4_096 }); }
export function handleAcroFormRadioRoute({ acroFormRadio, ...options }) { return handle({ ...options, service: acroFormRadio, kind: 'radio', profile: PDF_ACROFORM_RADIO_PROFILE, bodyLimit: 16_384 }); }
export function handleAcroFormTextFieldRoute({ acroFormTextField, ...options }) { return handle({ ...options, service: acroFormTextField, kind: 'text-field', operation: options.operation, profile: PDF_ACROFORM_TEXT_FIELD_PROFILE, bodyLimit: 4_096 }); }
export function handleAcroFormChoiceRoute({ acroFormChoice, ...options }) { return handle({ ...options, service: acroFormChoice, kind: 'choice', operation: options.operation, profile: PDF_ACROFORM_CHOICE_PROFILE, bodyLimit: 16_384 }); }
export function handleAcroFormSignatureFieldRoute({ acroFormSignatureField, ...options }) { return handle({ ...options, service: acroFormSignatureField, kind: 'signature-field', operation: options.operation, profile: PDF_ACROFORM_SIGNATURE_FIELD_PROFILE, bodyLimit: 4_096 }); }

function digest(value, encoding = 'utf8') { return createHash('sha256').update(Buffer.from(value, encoding)).digest('hex'); }
function sameRect(left, right) { return left && right && ['x', 'y', 'width', 'height'].every((key) => left[key] === right[key]); }

function validBarcodeResult(result, documentId, request) {
  const artifact = result?.artifact;
  const operation = artifact?.operation;
  const input = operation?.inputs?.length === 1 ? operation.inputs[0] : null;
  const parameters = operation?.parameters;
  return result?.kind === 'pdf-acroform-barcode'
    && result?.proof?.profile === PDF_ACROFORM_BARCODE_PROFILE
    && result.proof.sourceSha256 === request.sourceSha256
    && result.proof.page === request.page
    && result.proof.fieldNameSha256 === digest(request.fieldName)
    && result.proof.payloadSha256 === digest(request.payload, 'ascii')
    && result.proof.symbology === request.symbology
    && sameRect(result.proof.rect, request.rect)
    && artifact && typeof artifact === 'object'
    && UUID.test(String(artifact.id ?? ''))
    && artifact.documentId === documentId
    && artifact.displayName === 'barcode-field.pdf'
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && SHA256.test(artifact.sha256 ?? '')
    && typeof artifact.createdAt === 'string'
    && operation?.type === 'pdf-acroform-barcode'
    && input?.documentId === documentId && input.sha256 === request.sourceSha256 && input.role === 'source'
    && parameters?.profile === request.profile && parameters.page === request.page
    && parameters.fieldNameSha256 === digest(request.fieldName)
    && parameters.payloadSha256 === digest(request.payload, 'ascii')
    && parameters.symbology === request.symbology && sameRect(parameters.rect, request.rect)
    && operation.expected?.outputSha256 === artifact.sha256
    && operation.validation?.passed === true
    && operation.validation.outputSha256 === artifact.sha256;
}

function disclosureSafeBarcodeResult(result) {
  const { artifact, proof, limitations } = result;
  return Object.freeze({
    kind: result.kind,
    artifact: Object.freeze({
      id: artifact.id,
      documentId: artifact.documentId,
      displayName: artifact.displayName,
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      operation: artifact.operation,
      createdAt: artifact.createdAt,
    }),
    proof,
    limitations,
  });
}

async function cleanupUntrustedBarcodeArtifact(store, result, documentId, sourceSha256) {
  const returned = result?.artifact;
  if (typeof returned?.id !== 'string' || typeof store?.getArtifact !== 'function' || typeof store.deleteArtifact !== 'function') return;
  let retained;
  try {
    retained = await store.getArtifact(returned.id);
  } catch {
    return;
  }
  const input = retained?.operation?.inputs?.length === 1 ? retained.operation.inputs[0] : null;
  if (!retained || retained.id !== returned.id || retained.documentId !== documentId
    || returned.documentId !== documentId || retained.sha256 !== returned.sha256
    || !SHA256.test(retained.sha256 ?? '') || input?.documentId !== documentId
    || input.sha256 !== sourceSha256 || retained.operation?.validation?.outputSha256 !== retained.sha256) return;
  await store.deleteArtifact(retained.id).catch(() => {});
}

export async function handleAcroFormBarcodeRoute(context) {
  const {
    request, response, url, documentId, operation, processing, store,
    acroFormBarcode, method, readJson, json,
  } = context;
  if (operation !== 'acroform-barcode') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'AcroForm barcode fields do not accept query parameters.', 400);
  if (!acroFormBarcode) throw new HostError('ACROFORM_BARCODE_UNAVAILABLE', 'AcroForm barcode fields are unavailable.', 503);
  const body = await readJson(request, 4_096);
  let normalized;
  try {
    normalized = normalizePdfAcroFormBarcodeRequest(body);
  } catch {
    throw new HostError('INVALID_ACROFORM_BARCODE_OPTIONS', 'The AcroForm barcode-field request is invalid.', 400);
  }
  const result = await acroFormBarcode.add(documentId, normalized, { signal: processing.signal });
  if (!validBarcodeResult(result, documentId, normalized)) {
    await cleanupUntrustedBarcodeArtifact(store, result, documentId, normalized.sourceSha256);
    throw new HostError('ACROFORM_BARCODE_RESULT_INVALID', 'AcroForm barcode-field evidence does not match the requested source.', 502);
  }
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result: disclosureSafeBarcodeResult(result) });
  return true;
}
