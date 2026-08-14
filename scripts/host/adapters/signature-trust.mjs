import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { runProcess } from '../process-runner.mjs';

export const SIGNATURE_TRUST_REQUEST_FILENAME = 'request.json';
export const SIGNATURE_TRUST_MAX_REQUEST_BYTES = 64 * 1024;
export const SIGNATURE_TRUST_MAX_RESPONSE_BYTES = 256 * 1024;
export const SIGNATURE_TRUST_MAX_STDERR_BYTES = 64 * 1024;
export const SIGNATURE_TRUST_MAX_TIMEOUT_MS = 30_000;

const DIGEST = /^[0-9a-f]{64}$/;
const SUBFILTER = /^[A-Za-z0-9._-]{1,128}$/;
const SUCCESS_KEYS = Object.freeze([
  'schema', 'profile', 'sourceSha256', 'evaluatedAt', 'verificationTimeBasis',
  'anchorBasis', 'certificateNetworkFetchAllowed', 'records',
]);
const RECORD_KEYS = Object.freeze(['byteRange', 'subFilter', 'cmsSha256', 'certificateChain']);
const CHAIN_KEYS = Object.freeze(['status', 'reason', 'chainLength']);
const CHAIN_STATUSES = new Set(['passes', 'fails', 'indeterminate', 'unsupported']);
const CHAIN_REASONS = new Set([
  'none', 'expired', 'not-yet-valid', 'not-trusted', 'explicitly-denied',
  'policy-failure', 'malformed-cms', 'missing-embedded-signer-certificate',
  'multiple-cms-signers', 'unsupported-subfilter', 'cms-signature-mismatch',
  'resource-limit', 'platform-error',
]);
const HELPER_ERROR_CODES = new Set([
  'INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'UNSAFE_WORKSPACE', 'INPUT_TOO_LARGE',
  'SOURCE_MISMATCH', 'DOCUMENT_UNREADABLE', 'RESOURCE_LIMIT',
  'RESPONSE_TOO_LARGE', 'EVALUATION_FAILED',
]);

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return resolve(value);
}

function isDescendant(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${String.fromCharCode(47)}`)
    && !isAbsolute(path);
}

async function validatedPrivateRequest(workspacePath, requestPath) {
  try {
    const rawWorkspace = absolutePath(workspacePath, 'workspacePath');
    const rawRequest = absolutePath(requestPath, 'requestPath');
    const [workspaceInfo, requestInfo] = await Promise.all([lstat(rawWorkspace), lstat(rawRequest)]);
    if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || (workspaceInfo.mode & 0o077) !== 0) {
      throw new TypeError('workspacePath must be a private directory');
    }
    if (!requestInfo.isFile() || requestInfo.isSymbolicLink() || requestInfo.nlink !== 1
      || requestInfo.size < 2 || requestInfo.size > SIGNATURE_TRUST_MAX_REQUEST_BYTES
      || (requestInfo.mode & 0o077) !== 0
      || resolve(rawWorkspace, SIGNATURE_TRUST_REQUEST_FILENAME) !== rawRequest) {
      throw new TypeError('requestPath must be the bounded private request.json file directly inside workspacePath');
    }
    const [workspace, request] = await Promise.all([realpath(rawWorkspace), realpath(rawRequest)]);
    if (!isDescendant(workspace, request) || resolve(workspace, SIGNATURE_TRUST_REQUEST_FILENAME) !== request) {
      throw new TypeError('requestPath must be the bounded private request.json file directly inside workspacePath');
    }
    return Object.freeze({ workspace, request });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('workspacePath and requestPath must resolve to private workspace files');
  }
}

function safeRunOptions(value) {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['signal', 'timeoutMs'].includes(key))) {
    throw new TypeError('runOptions may contain only signal and timeoutMs');
  }
  const result = {};
  if (value.signal !== undefined) {
    if (!(value.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    result.signal = value.signal;
  }
  if (value.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1
      || value.timeoutMs > SIGNATURE_TRUST_MAX_TIMEOUT_MS) {
      throw new TypeError(`timeoutMs must be an integer from 1 through ${SIGNATURE_TRUST_MAX_TIMEOUT_MS}`);
    }
    result.timeoutMs = value.timeoutMs;
  }
  return Object.freeze(result);
}

function responseError(code) {
  const error = new Error(`Signature trust helper returned ${code}`);
  error.code = code;
  return error;
}

function canonicalUtcMilliseconds(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validByteRange(value) {
  if (!Array.isArray(value) || value.length !== 4
    || !value.every((entry) => Number.isSafeInteger(entry) && entry >= 0)) return false;
  const [firstOffset, firstLength, secondOffset, secondLength] = value;
  return firstOffset === 0 && firstLength > 0 && secondOffset > firstLength
    && secondLength > 0 && secondOffset + secondLength <= Number.MAX_SAFE_INTEGER;
}

function validChain(value) {
  if (!exactObject(value, CHAIN_KEYS) || !CHAIN_STATUSES.has(value.status)
    || !CHAIN_REASONS.has(value.reason)) return false;
  const boundedLength = Number.isSafeInteger(value.chainLength)
    && value.chainLength >= 1 && value.chainLength <= 16;
  if (value.status === 'passes') return value.reason === 'none' && boundedLength;
  if (value.status === 'fails') return value.reason !== 'none' && boundedLength;
  if (value.status === 'unsupported') {
    return value.chainLength === null
      && value.reason === 'unsupported-subfilter';
  }
  return value.chainLength === null && value.reason !== 'none';
}

function frozenRecord(value) {
  if (!exactObject(value, RECORD_KEYS) || !validByteRange(value.byteRange)
    || !(value.subFilter === null || (typeof value.subFilter === 'string' && SUBFILTER.test(value.subFilter)))
    || !DIGEST.test(value.cmsSha256 ?? '')
    || !validChain(value.certificateChain)) return null;
  return Object.freeze({
    byteRange: Object.freeze([...value.byteRange]),
    subFilter: value.subFilter,
    cmsSha256: value.cmsSha256,
    certificateChain: Object.freeze({ ...value.certificateChain }),
  });
}

export function parseSignatureTrustResponse(output) {
  let envelope;
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > SIGNATURE_TRUST_MAX_RESPONSE_BYTES) {
      throw new Error('invalid response bytes');
    }
    envelope = JSON.parse(output);
  } catch {
    throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
  }
  if (!exactObject(envelope, envelope?.ok === true ? ['version', 'ok', 'result'] : ['version', 'ok', 'error'])
    || envelope.version !== 1) throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
  if (envelope.ok === false) {
    if (!exactObject(envelope.error, ['code']) || !HELPER_ERROR_CODES.has(envelope.error.code)) {
      throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
    }
    throw responseError(`SIGNATURE_TRUST_${envelope.error.code}`);
  }
  if (envelope.ok !== true || !exactObject(envelope.result, SUCCESS_KEYS)) {
    throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
  }
  const result = envelope.result;
  if (result.schema !== 'macos-signature-chain-receipt-v2'
    || result.profile !== 'macos-basic-x509-current-trust-v2'
    || !DIGEST.test(result.sourceSha256 ?? '') || !canonicalUtcMilliseconds(result.evaluatedAt)
    || result.verificationTimeBasis !== 'host-current-time'
    || result.anchorBasis !== 'current-macos-trust-configuration'
    || result.certificateNetworkFetchAllowed !== false
    || !Array.isArray(result.records) || result.records.length > 100) {
    throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
  }
  const records = result.records.map(frozenRecord);
  if (records.some((record) => record === null)) throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
  const ranges = new Set(records.map(({ byteRange }) => byteRange.join(':')));
  if (ranges.size !== records.length) throw responseError('SIGNATURE_TRUST_RESPONSE_INVALID');
  return Object.freeze({
    ...result,
    records: Object.freeze(records),
  });
}

export class SignatureTrustAdapter {
  #executable;
  #expectedSha256;
  #runner;
  #verifyExecutable;

  constructor({ executable, expectedSha256, runner = runProcess, verifyExecutable } = {}) {
    this.#executable = absolutePath(executable, 'executable');
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
      throw new TypeError('expectedSha256 must be a SHA-256 digest');
    }
    if (typeof verifyExecutable !== 'function') throw new TypeError('verifyExecutable must be a function');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#expectedSha256 = expectedSha256.toLowerCase();
    this.#verifyExecutable = verifyExecutable;
    this.#runner = runner;
  }

  async evaluate({ workspacePath, requestPath }, runOptions = {}) {
    const { workspace, request } = await validatedPrivateRequest(workspacePath, requestPath);
    const safeOptions = safeRunOptions(runOptions);
    try {
      await this.#verifyExecutable({
        executable: this.#executable,
        expectedSha256: this.#expectedSha256,
      });
    } catch {
      throw responseError('SIGNATURE_TRUST_HELPER_UNTRUSTED');
    }
    let response;
    try {
      response = await this.#runner({
        ...safeOptions,
        executable: this.#executable,
        args: ['--request', request],
        cwd: workspace,
        maxStdoutBytes: SIGNATURE_TRUST_MAX_RESPONSE_BYTES,
        maxStderrBytes: SIGNATURE_TRUST_MAX_STDERR_BYTES,
      });
    } catch (error) {
      if (error?.code === 'ENGINE_CANCELLED') throw error;
      throw responseError('SIGNATURE_TRUST_HELPER_FAILED');
    }
    return parseSignatureTrustResponse(response.stdout);
  }
}

export function createSignatureTrustRequestPath(workspacePath) {
  return resolve(absolutePath(workspacePath, 'workspacePath'), SIGNATURE_TRUST_REQUEST_FILENAME);
}
