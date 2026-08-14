import { isProxy } from 'node:util/types';
import { HostError } from '../host-error.mjs';
import { ELECTRONIC_SIGNING_INTENT_PROFILE } from '../electronic-signing-intent-service.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESULT_KEYS = Object.freeze([
  'kind', 'profile', 'documentId', 'sourceSha256', 'workspaceRevision', 'recordId',
  'signerSha256', 'intentSha256', 'consentRecorded', 'localOnly',
  'certificateSignature', 'identityVerified', 'timestampTrusted',
  'legalEffectDetermined', 'limitations',
]);

function dataObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
  let prototype; let descriptors; let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(descriptors);
  } catch { return null; }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) return null;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function boundedLimitations(value) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > 8) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string')
    || expected.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) return null;
  const copy = [];
  for (const key of expected) {
    const entry = descriptors[key].value;
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 240
      || Buffer.byteLength(entry, 'utf8') > 960) return null;
    copy.push(entry);
  }
  return Object.freeze(copy);
}

function publicReceipt(result, { documentId, sourceSha256, expectedRevision }) {
  const value = dataObject(result, RESULT_KEYS);
  const limitations = boundedLimitations(value?.limitations);
  if (!value || value.kind !== 'electronic-signing-intent'
    || value.profile !== ELECTRONIC_SIGNING_INTENT_PROFILE
    || value.documentId !== documentId || value.sourceSha256 !== sourceSha256
    || value.workspaceRevision !== expectedRevision + 1 || !RECORD_ID.test(value.recordId ?? '')
    || !SHA256.test(value.signerSha256 ?? '') || !SHA256.test(value.intentSha256 ?? '')
    || value.consentRecorded !== true || value.localOnly !== true
    || value.certificateSignature !== false || value.identityVerified !== false
    || value.timestampTrusted !== false || value.legalEffectDetermined !== false
    || !limitations) {
    throw new HostError(
      'ELECTRONIC_SIGNING_INTENT_RESULT_INVALID',
      'The electronic signing-intent service returned an invalid receipt.',
      502,
    );
  }
  return Object.freeze({ ...value, limitations });
}

export async function handleElectronicSigningIntentRoute({
  request, response, url, documentId, operation, processing,
  electronicSigningIntent, bodyLimit, exactJsonObject, method, readJson, json,
}) {
  if (operation !== 'electronic-signing-intent') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Electronic signing intent does not accept query parameters.', 400);
  }
  if (!electronicSigningIntent || typeof electronicSigningIntent.record !== 'function') {
    throw new HostError('ELECTRONIC_SIGNING_INTENT_UNAVAILABLE', 'Local electronic signing intent is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, [
    'profile', 'sourceSha256', 'expectedRevision', 'signer', 'intent', 'consent',
  ])) {
    throw new HostError('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', 'Electronic signing intent requires the exact fixed request.', 400);
  }
  const result = await electronicSigningIntent.record(documentId, body, { signal: processing.signal });
  json(response, 201, { result: publicReceipt(result, {
    documentId, sourceSha256: body.sourceSha256, expectedRevision: body.expectedRevision,
  }) });
  return true;
}
