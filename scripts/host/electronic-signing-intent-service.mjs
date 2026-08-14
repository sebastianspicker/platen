import { createHash, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';

export const ELECTRONIC_SIGNING_INTENT_PROFILE = 'local-electronic-signing-intent-v1';

const SHA256 = /^[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze([
  'profile', 'sourceSha256', 'expectedRevision', 'signer', 'intent', 'consent',
]);
const RECORD_KEYS = Object.freeze([
  'id', 'type', 'profile', 'sourceSha256', 'signerSha256', 'intentSha256',
  'consentRecorded', 'certificateSignature', 'identityVerified', 'timestampTrusted',
  'legalEffectDetermined', 'localOnly',
]);
const RECEIPT_LIMITATIONS = Object.freeze([
  'Local record only; no external electronic-signing authority is contacted.',
  'No PDF appearance or mutation is performed.',
  'No certificate, identity, trusted-timestamp, or legal-effect claim is made.',
  'No audit-trail or routing claim is made.',
]);
const STORE_METHODS = Object.freeze(['getDocument', 'verifySource']);
const WORKSPACE_METHODS = Object.freeze(['snapshot', 'createEntity', 'deleteEntity']);

function host(code, message, status = 400, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function fail(code, message, status = 400) {
  throw host(code, message, status);
}

function assertSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
}

function abortIfNeeded(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'Electronic signing intent recording was cancelled.', 499);
}

function isWellFormedUtf16(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function ownDataObject(value, label, { exactKeys } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} must be a plain data object.`);
  }
  let prototype; let descriptors; let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} must be a plain data object.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} must have a plain prototype.`);
  }
  // A toJSON inherited from a user-provided Object.prototype would make any
  // later JSON boundary execute attacker-controlled code.
  for (let parent = prototype; parent; parent = Object.getPrototypeOf(parent)) {
    if (Object.hasOwn(parent, 'toJSON')) {
      fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} has an inherited JSON hook.`);
    }
  }
  if (keys.some((key) => typeof key !== 'string')) {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} contains an unsupported key.`);
  }
  if (keys.some((key) => !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} contains an accessor or non-enumerable field.`);
  }
  if (exactKeys && (keys.length !== exactKeys.length || keys.some((key) => !exactKeys.includes(key)))) {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} contains unsupported fields.`);
  }
  return descriptors;
}

function boundedUtf8(value, label, maxCharacters, maxBytes) {
  if (typeof value !== 'string' || !isWellFormedUtf16(value)
    || value.length === 0 || Array.from(value).length > maxCharacters
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', `${label} is outside its UTF-8 bounds.`);
  }
  return value;
}

function hashUtf8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readData(value, key, label) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', `${label} is not valid retained data.`, 502);
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', `${label} is not valid retained data.`, 502);
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', `${label} is not valid retained data.`, 502);
  }
  return descriptor.value;
}

function exactRecord(value, expected) {
  const descriptors = ownDataObject(value, 'retained record');
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== RECORD_KEYS.length || keys.some((key) => !RECORD_KEYS.includes(key))) {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', 'The retained signing-intent record was not exact.', 502);
  }
  for (const key of RECORD_KEYS) {
    if (descriptors[key].value !== expected[key]) {
      fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', 'The retained signing-intent record was not exact.', 502);
    }
  }
}

function readbackRecord(snapshot, documentId, recordId, expected) {
  const namespaces = readData(snapshot, 'namespaces', 'workspace namespaces');
  const records = readData(namespaces, 'workflowRecords', 'workflow-record namespace');
  if (!Array.isArray(records) || isProxy(records) || Object.getPrototypeOf(records) !== Array.prototype) {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', 'The workflow-record namespace was not valid.', 502);
  }
  const descriptors = Object.getOwnPropertyDescriptors(records);
  const keys = Reflect.ownKeys(records);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string'
    || !/^\d+$/u.test(key) || !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value')))) {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', 'The workflow-record namespace was not valid.', 502);
  }
  const matches = records.filter((record) => readData(record, 'id', 'workflow record') === recordId);
  if (matches.length !== 1) {
    fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', 'The created signing-intent record was not retained exactly.', 502);
  }
  exactRecord(matches[0], expected);
  return matches[0];
}

function safeFailure(error, fallbackCode, fallbackMessage, status = 502) {
  if (error instanceof HostError && typeof error.code === 'string') return error;
  return host(fallbackCode, fallbackMessage, status);
}

function cleanupFailure(error) {
  const causes = error instanceof AggregateError && Array.isArray(error.errors)
    ? error.errors.map(() => new Error('electronic signing intent operation failed'))
    : [new Error('electronic signing intent operation failed')];
  return host('ELECTRONIC_SIGNING_INTENT_CLEANUP_FAILED', 'Electronic signing intent cleanup failed.', 500, new AggregateError(causes, 'electronic signing intent cleanup failed'));
}

export class ElectronicSigningIntentService {
  #store;
  #workspace;
  #idFactory;

  constructor({ store, workspaceState, clock = () => new Date().toISOString(), idFactory = () => randomUUID() } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('ElectronicSigningIntentService requires a document store with source verification.');
    }
    if (!workspaceState || WORKSPACE_METHODS.some((name) => typeof workspaceState[name] !== 'function')) {
      throw new TypeError('ElectronicSigningIntentService requires an authoritative workspace state store.');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function.');
    this.#store = store;
    this.#workspace = workspaceState;
    this.#idFactory = idFactory;
  }

  async record(documentId, request, { signal } = {}) {
    assertSignal(signal);
    abortIfNeeded(signal);
    const descriptors = ownDataObject(request, 'request', { exactKeys: REQUEST_KEYS });
    const input = Object.fromEntries(REQUEST_KEYS.map((key) => [key, descriptors[key].value]));
    if (input.profile !== ELECTRONIC_SIGNING_INTENT_PROFILE) fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', 'The signing-intent profile is unsupported.');
    if (typeof input.sourceSha256 !== 'string' || !SHA256.test(input.sourceSha256)) fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', 'sourceSha256 must be a lowercase SHA-256 digest.');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', 'expectedRevision must be a safe non-negative integer.');
    const signer = boundedUtf8(input.signer, 'signer', 80, 320);
    const intent = boundedUtf8(input.intent, 'intent', 200, 800);
    if (input.consent !== true) fail('INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST', 'Explicit consent is required.');

    const source = this.#store.getDocument(documentId);
    const sourceSha256 = readData(source, 'sha256', 'retained document');
    if (sourceSha256 !== input.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'The signing-intent source digest does not match the retained document.', 409);
    try {
      await this.#store.verifySource(documentId);
      const current = this.#store.getDocument(documentId);
      if (readData(current, 'sha256', 'retained document') !== input.sourceSha256) {
        fail('SOURCE_INTEGRITY_FAILED', 'The retained document changed during source verification.', 409);
      }
    } catch (error) {
      if (signal?.aborted) fail('JOB_CANCELLED', 'Electronic signing intent recording was cancelled.', 499);
      if (error instanceof HostError) throw error;
      throw host('SOURCE_INTEGRITY_FAILED', 'The retained document could not be source-verified.', 502);
    }
    abortIfNeeded(signal);

    const initialWorkspace = this.#workspace.snapshot(documentId);
    const revision = readData(initialWorkspace, 'revision', 'workspace revision');
    if (!Number.isSafeInteger(revision) || revision !== input.expectedRevision) {
      fail('REVISION_CONFLICT', 'The signing-intent workspace revision is stale.', 409);
    }
    const recordId = this.#idFactory('electronic-signing-intent');
    if (typeof recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(recordId)) {
      fail('ELECTRONIC_SIGNING_INTENT_FAILED', 'The signing-intent record identifier was invalid.', 502);
    }
    const record = {
      id: recordId,
      type: 'electronic-signing-intent',
      profile: ELECTRONIC_SIGNING_INTENT_PROFILE,
      sourceSha256: input.sourceSha256,
      signerSha256: hashUtf8(signer),
      intentSha256: hashUtf8(intent),
      consentRecorded: true,
      certificateSignature: false,
      identityVerified: false,
      timestampTrusted: false,
      legalEffectDetermined: false,
      localOnly: true,
    };
    let created = false;
    const createdRevision = input.expectedRevision + 1;
    try {
      this.#workspace.createEntity(documentId, 'workflowRecords', record, { expectedRevision: input.expectedRevision });
      created = true;
      abortIfNeeded(signal);
      const snapshot = this.#workspace.snapshot(documentId);
      if (readData(snapshot, 'revision', 'workspace revision') !== createdRevision) {
        fail('ELECTRONIC_SIGNING_INTENT_READBACK_INVALID', 'The signing-intent workspace revision was not retained exactly.', 502);
      }
      readbackRecord(snapshot, documentId, recordId, record);
      abortIfNeeded(signal);
      return Object.freeze({
        kind: 'electronic-signing-intent',
        profile: ELECTRONIC_SIGNING_INTENT_PROFILE,
        documentId,
        sourceSha256: input.sourceSha256,
        workspaceRevision: createdRevision,
        recordId,
        signerSha256: record.signerSha256,
        intentSha256: record.intentSha256,
        consentRecorded: true,
        localOnly: true,
        certificateSignature: false,
        identityVerified: false,
        timestampTrusted: false,
        legalEffectDetermined: false,
        limitations: RECEIPT_LIMITATIONS,
      });
    } catch (error) {
      const operationError = signal?.aborted
        ? host('JOB_CANCELLED', 'Electronic signing intent recording was cancelled.', 499)
        : safeFailure(error, 'ELECTRONIC_SIGNING_INTENT_FAILED', 'The local signing-intent record could not be verified.');
      if (!created) throw operationError;
      try {
        this.#workspace.deleteEntity(documentId, 'workflowRecords', recordId, { expectedRevision: createdRevision });
      } catch (cleanupError) {
        throw cleanupFailure(new AggregateError([operationError, new Error('cleanup failed')]));
      }
      throw operationError;
    }
  }
}
