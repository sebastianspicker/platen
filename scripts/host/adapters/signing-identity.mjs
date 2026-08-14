import { createHash } from 'node:crypto';
import { constants, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { runProcess } from '../process-runner.mjs';

export const SIGNING_IDENTITY_REQUEST_FILENAME = 'request.json';
export const SIGNING_IDENTITY_INPUT_FILENAME = 'input.bin';
export const SIGNING_IDENTITY_OUTPUT_FILENAME = 'detached.cms';
export const SIGNING_IDENTITY_MAX_REQUEST_BYTES = 64 * 1024;
export const SIGNING_IDENTITY_MAX_RESPONSE_BYTES = 256 * 1024;
export const SIGNING_IDENTITY_MAX_STDOUT_BYTES = SIGNING_IDENTITY_MAX_RESPONSE_BYTES;
export const SIGNING_IDENTITY_MAX_STDERR_BYTES = 64 * 1024;
export const SIGNING_IDENTITY_MAX_TIMEOUT_MS = 30_000;
export const SIGNING_IDENTITY_MAX_CERTIFICATE_BYTES = 65_536;
export const SIGNING_IDENTITY_MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const SIGNING_IDENTITY_MAX_CMS_BYTES = 16 * 1024 * 1024;

const DIGEST = /^[0-9a-f]{64}$/;
const LIST_OPERATION = 'listSigningIdentities';
const CMS_OPERATION = 'createDetachedCMS';
const VERIFY_OPERATION = 'verifyDetachedCMS';
const LIST_RESULT_KEYS = Object.freeze(['operation', 'identities']);
const CMS_RESULT_KEYS = Object.freeze(['operation', 'certificateSha256', 'inputSha256', 'cmsSha256', 'cmsBytes', 'outputFilename']);
const VERIFY_RESULT_KEYS = Object.freeze([
  'operation', 'inputSha256', 'cmsSha256', 'certificateSha256', 'signatureValid',
  'trustStatus', 'trustReason', 'timestampValidated', 'ltv', 'revocationOnlineChecked',
]);
const LIST_IDENTITY_KEYS = Object.freeze(['certificateSha256', 'certificateBytes']);
const HELPER_ERROR_CODES = new Set([
  'INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'UNSAFE_WORKSPACE', 'INPUT_TOO_LARGE',
  'SOURCE_MISMATCH', 'IDENTITY_NOT_FOUND', 'PLATFORM_DENIED', 'CMS_FAILED',
  'OUTPUT_EXISTS', 'OUTPUT_WRITE_FAILED', 'RESPONSE_TOO_LARGE',
  'CMS_INVALID', 'CMS_MULTIPLE_SIGNERS', 'TRUST_INDETERMINATE',
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
  return path !== '' && path !== '..' && !path.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(path);
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
      || requestInfo.size < 2 || requestInfo.size > SIGNING_IDENTITY_MAX_REQUEST_BYTES
      || (requestInfo.mode & 0o077) !== 0
      || resolve(rawWorkspace, SIGNING_IDENTITY_REQUEST_FILENAME) !== rawRequest) {
      throw new TypeError('requestPath must be the bounded private request.json file directly inside workspacePath');
    }
    const [workspace, request] = await Promise.all([realpath(rawWorkspace), realpath(rawRequest)]);
    if (!isDescendant(workspace, request) || resolve(workspace, SIGNING_IDENTITY_REQUEST_FILENAME) !== request) {
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
    if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > SIGNING_IDENTITY_MAX_TIMEOUT_MS) {
      throw new TypeError(`timeoutMs must be an integer from 1 through ${SIGNING_IDENTITY_MAX_TIMEOUT_MS}`);
    }
    result.timeoutMs = value.timeoutMs;
  }
  return Object.freeze(result);
}

function responseError(code) {
  const error = new Error(`Signing identity helper returned ${code}`);
  error.code = `SIGNING_IDENTITY_${code}`;
  return error;
}

function canonicalIntBytes(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validIdentity(identity) {
  if (!exactObject(identity, LIST_IDENTITY_KEYS)) return null;
  if (!DIGEST.test(identity.certificateSha256 ?? '') || !canonicalIntBytes(identity.certificateBytes, 1, SIGNING_IDENTITY_MAX_CERTIFICATE_BYTES)) return null;
  return Object.freeze({
    certificateSha256: identity.certificateSha256,
    certificateBytes: identity.certificateBytes,
  });
}

function sortedUniqueIdentities(value) {
  const identities = (value || []).map(validIdentity);
  if (identities.some((entry) => entry === null)) return null;
  for (let index = 1; index < identities.length; index += 1) {
    if (identities[index - 1].certificateSha256 > identities[index].certificateSha256) return null;
    if (identities[index - 1].certificateSha256 === identities[index].certificateSha256) return null;
  }
  return Object.freeze(identities);
}

function validCmsResult(value) {
  if (!exactObject(value, CMS_RESULT_KEYS) || value.operation !== CMS_OPERATION
    || !DIGEST.test(value.certificateSha256 ?? '')
    || !DIGEST.test(value.inputSha256 ?? '')
    || !DIGEST.test(value.cmsSha256 ?? '')
    || value.outputFilename !== SIGNING_IDENTITY_OUTPUT_FILENAME
    || !canonicalIntBytes(value.cmsBytes, 1, SIGNING_IDENTITY_MAX_CMS_BYTES)) {
    return null;
  }
  return Object.freeze({
    operation: value.operation,
    certificateSha256: value.certificateSha256,
    inputSha256: value.inputSha256,
    cmsSha256: value.cmsSha256,
    cmsBytes: value.cmsBytes,
    outputFilename: value.outputFilename,
  });
}

function validVerifyResult(value) {
  if (!exactObject(value, VERIFY_RESULT_KEYS) || value.operation !== VERIFY_OPERATION
    || !DIGEST.test(value.inputSha256 ?? '')
    || !DIGEST.test(value.cmsSha256 ?? '')
    || !DIGEST.test(value.certificateSha256 ?? '')
    || typeof value.signatureValid !== 'boolean'
    || (value.trustStatus !== 'passes' && value.trustStatus !== 'fails')
    || !['none', 'expired', 'not-yet-valid', 'explicitly-denied', 'not-trusted', 'policy-failure'].includes(value.trustReason)
    || value.timestampValidated !== false || value.ltv !== false || value.revocationOnlineChecked !== false) {
    return null;
  }
  return Object.freeze({
    operation: value.operation,
    inputSha256: value.inputSha256,
    cmsSha256: value.cmsSha256,
    certificateSha256: value.certificateSha256,
    signatureValid: value.signatureValid,
    trustStatus: value.trustStatus,
    trustReason: value.trustReason,
    timestampValidated: false,
    ltv: false,
    revocationOnlineChecked: false,
  });
}

async function verifyDetachedCmsOutput(workspacePath, result) {
  if (result.outputFilename !== SIGNING_IDENTITY_OUTPUT_FILENAME) {
    throw new Error('Unexpected detached CMS filename');
  }
  const detachedCmsPath = resolve(workspacePath, SIGNING_IDENTITY_OUTPUT_FILENAME);
  const handle = await open(detachedCmsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
      || opened.size !== result.cmsBytes || (opened.mode & 0o777) !== 0o600) {
      throw new Error('Detached CMS output has unexpected metadata');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== result.cmsBytes) throw new Error('Detached CMS output length mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== result.cmsSha256) {
      throw new Error('Detached CMS output digest mismatch');
    }
    const after = await handle.stat();
    if (after.nlink !== opened.nlink || after.size !== opened.size || (after.mode & 0o777) !== (opened.mode & 0o777)
      || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Detached CMS output changed during verification');
    }
  } finally {
    await handle.close();
  }
}

async function verifyDetachedCmsInputs(workspacePath, result) {
  const expected = [
    [SIGNING_IDENTITY_INPUT_FILENAME, result.inputSha256, SIGNING_IDENTITY_MAX_INPUT_BYTES],
    [SIGNING_IDENTITY_OUTPUT_FILENAME, result.cmsSha256, SIGNING_IDENTITY_MAX_CMS_BYTES],
  ];
  for (const [filename, expectedSha256, maxBytes] of expected) {
    const path = resolve(workspacePath, filename);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
        || opened.size < 1 || opened.size > maxBytes) {
        throw new Error('Detached CMS verification input has unexpected metadata');
      }
      const bytes = await handle.readFile();
      if (bytes.length !== opened.size || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
        throw new Error('Detached CMS verification input digest mismatch');
      }
      const after = await handle.stat();
      if (!after.isFile() || after.nlink !== opened.nlink || after.size !== opened.size
        || (after.mode & 0o777) !== (opened.mode & 0o777) || after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error('Detached CMS verification input changed during verification');
      }
    } finally {
      await handle.close();
    }
  }
}

export function parseSigningIdentityResponse(output, expectedOperation) {
  if (![LIST_OPERATION, CMS_OPERATION, VERIFY_OPERATION].includes(expectedOperation)) {
    throw new TypeError('expectedOperation must be listSigningIdentities, createDetachedCMS, or verifyDetachedCMS');
  }
  let envelope;
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > SIGNING_IDENTITY_MAX_RESPONSE_BYTES) {
      throw new Error('invalid response bytes');
    }
    envelope = JSON.parse(output);
  } catch {
    throw responseError('RESPONSE_INVALID');
  }
  if (!exactObject(envelope, ['version', 'ok', 'result']) && !exactObject(envelope, ['version', 'ok', 'error'])) {
    throw responseError('RESPONSE_INVALID');
  }
  if (envelope.version !== 1 || typeof envelope.ok !== 'boolean') throw responseError('RESPONSE_INVALID');
  if (envelope.ok === false) {
    if (!exactObject(envelope.error, ['code']) || !HELPER_ERROR_CODES.has(envelope.error.code)) {
      throw responseError('RESPONSE_INVALID');
    }
    throw responseError(envelope.error.code);
  }
  if (envelope.ok !== true) throw responseError('RESPONSE_INVALID');
  const resultKeys = expectedOperation === CMS_OPERATION ? CMS_RESULT_KEYS
    : expectedOperation === VERIFY_OPERATION ? VERIFY_RESULT_KEYS : LIST_RESULT_KEYS;
  if (!exactObject(envelope.result, resultKeys)) {
    throw responseError('RESPONSE_INVALID');
  }
  if (envelope.result.operation !== expectedOperation) throw responseError('RESPONSE_INVALID');
  if (expectedOperation === CMS_OPERATION) {
    const cms = validCmsResult(envelope.result);
    if (!cms) throw responseError('RESPONSE_INVALID');
    return Object.freeze({
      version: 1,
      ok: true,
      result: cms,
    });
  }
  if (expectedOperation === VERIFY_OPERATION) {
    const verification = validVerifyResult(envelope.result);
    if (!verification) throw responseError('RESPONSE_INVALID');
    return Object.freeze({ version: 1, ok: true, result: verification });
  }
  const resultIdentities = envelope.result.identities;
  if (!Array.isArray(resultIdentities) || resultIdentities.length > 10_000) throw responseError('RESPONSE_INVALID');
  const identities = sortedUniqueIdentities(resultIdentities);
  if (!identities) throw responseError('RESPONSE_INVALID');
  return Object.freeze({
    version: 1,
    ok: true,
    result: Object.freeze({
      operation: LIST_OPERATION,
      identities,
    }),
  });
}

export function parseSigningIdentityListResponse(output) {
  return parseSigningIdentityResponse(output, LIST_OPERATION);
}

export function parseSigningIdentityCreateDetachedCmsResponse(output) {
  return parseSigningIdentityResponse(output, CMS_OPERATION);
}

export function parseSigningIdentityVerifyDetachedCmsResponse(output) {
  return parseSigningIdentityResponse(output, VERIFY_OPERATION);
}

export class SigningIdentityAdapter {
  #executable;
  #expectedSha256;
  #runner;
  #verifyExecutable;

  constructor({ executable, expectedSha256, runner = runProcess, verifyExecutable } = {}) {
    this.#executable = absolutePath(executable, 'executable');
    if (typeof expectedSha256 !== 'string' || !DIGEST.test(expectedSha256)) {
      throw new TypeError('expectedSha256 must be a SHA-256 digest');
    }
    if (typeof verifyExecutable !== 'function') throw new TypeError('verifyExecutable must be a function');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#expectedSha256 = expectedSha256.toLowerCase();
    this.#verifyExecutable = verifyExecutable;
    this.#runner = runner;
  }

  async listIdentities({ workspacePath, requestPath }, runOptions = {}) {
    return this.#run({ workspacePath, requestPath }, runOptions, parseSigningIdentityListResponse);
  }

  async createDetachedCms({ workspacePath, requestPath }, runOptions = {}) {
    return this.#run({ workspacePath, requestPath }, runOptions, parseSigningIdentityCreateDetachedCmsResponse);
  }

  async verifyDetachedCms({ workspacePath, requestPath }, runOptions = {}) {
    return this.#run({ workspacePath, requestPath }, runOptions, parseSigningIdentityVerifyDetachedCmsResponse);
  }

  async #verify() {
    try {
      await this.#verifyExecutable({
        executable: this.#executable,
        expectedSha256: this.#expectedSha256,
      });
    } catch {
      throw responseError('HELPER_UNTRUSTED');
    }
  }

  async #run({ workspacePath, requestPath }, runOptions, parseResponse) {
    const { workspace, request } = await validatedPrivateRequest(workspacePath, requestPath);
    const safeOptions = safeRunOptions(runOptions);
    await this.#verify();
    let result;
    try {
      result = await this.#runner({
        ...safeOptions,
        executable: this.#executable,
        args: ['--request', request],
        cwd: workspace,
        maxStdoutBytes: SIGNING_IDENTITY_MAX_STDOUT_BYTES,
        maxStderrBytes: SIGNING_IDENTITY_MAX_STDERR_BYTES,
      });
    } catch (error) {
      if (error?.code === 'ENGINE_CANCELLED') throw error;
      throw responseError('HELPER_FAILED');
    }
    const parsed = parseResponse(result.stdout);
    if (parseResponse === parseSigningIdentityCreateDetachedCmsResponse) {
      try {
        await verifyDetachedCmsOutput(workspace, parsed.result);
      } catch {
        throw responseError('HELPER_FAILED');
      }
    }
    if (parseResponse === parseSigningIdentityVerifyDetachedCmsResponse) {
      try {
        await verifyDetachedCmsInputs(workspace, parsed.result);
      } catch {
        throw responseError('HELPER_FAILED');
      }
    }
    return parsed;
  }
}

export function createSigningIdentityRequestPath(workspacePath) {
  return resolve(absolutePath(workspacePath, 'workspacePath'), SIGNING_IDENTITY_REQUEST_FILENAME);
}
