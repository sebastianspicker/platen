import { runProcess } from './process-runner.mjs';

const REQUEST = Buffer.from('{"version":1,"operation":"list"}\n', 'utf8');
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_DEVICES = 64;
const MAX_TEXT = 160;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SCAN_SUPPORT = new Set(['unsupported', 'unavailable-on-platform']);
const ENVELOPE_KEYS = ['version', 'ok', 'result', 'error'];

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function dataArray(value, min = 0, max = MAX_DEVICES) {
  if (!Array.isArray(value) || value.length < min || value.length > max || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.length?.enumerable || descriptors.length?.get || descriptors.length?.set || Object.keys(descriptors).some((key) => key !== 'length' && (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')))) return false;
  return Object.keys(value).length === value.length;
}

function boundedText(value) {
  return typeof value === 'string' && value === value.normalize('NFC') && value.length > 0
    && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f\u007f\ud800-\udfff]/u.test(value);
}

function validEvidence(value) {
  return exact(value, ['api', 'discoveryAttempted', 'liveVerification', 'scanSupport'])
    && value.api === 'ImageCaptureCore' && typeof value.discoveryAttempted === 'boolean'
    && value.liveVerification === false && SCAN_SUPPORT.has(value.scanSupport);
}

function parseEnvelope(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_FRAME_BYTES) throw new Error('scanner response exceeded bounds');
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error('scanner response must contain exactly one NDJSON frame');
  let envelope;
  try { envelope = JSON.parse(lines[0]); } catch { throw new Error('scanner response is not JSON'); }
  const shape = envelope?.ok === true ? (exact(envelope, ['version', 'ok', 'result']) || exact(envelope, ENVELOPE_KEYS)) : (exact(envelope, ['version', 'ok', 'error']) || exact(envelope, ENVELOPE_KEYS));
  if (!shape || envelope.version !== 1 || typeof envelope.ok !== 'boolean') throw new Error('scanner response envelope is invalid');
  if (envelope.ok) {
    if ((Object.hasOwn(envelope, 'error') && envelope.error !== null) || !exact(envelope.result, ['devices', 'evidence']) || !dataArray(envelope.result.devices) || !validEvidence(envelope.result.evidence)) throw new Error('scanner discovery result is invalid');
    const ids = new Set();
    const devices = envelope.result.devices.map((device) => {
      if (!exact(device, ['id', 'name', 'kind', 'capabilities']) || !ID.test(device.id) || ids.has(device.id) || !boundedText(device.name) || device.kind !== 'scanner' || !dataArray(device.capabilities, 1, 1) || device.capabilities[0] !== 'image-acquisition-discovery') throw new Error('scanner device record is invalid');
      ids.add(device.id);
      return Object.freeze({ id: device.id, name: device.name, kind: device.kind, capabilities: Object.freeze([...device.capabilities]) });
    });
    return Object.freeze({ version: 1, ok: true, result: Object.freeze({ devices: Object.freeze(devices), evidence: Object.freeze({ ...envelope.result.evidence }) }), error: null });
  }
  if ((Object.hasOwn(envelope, 'result') && envelope.result !== null) || !exact(envelope.error, ['code', 'reason', 'evidence']) || !ID.test(envelope.error.code) || !boundedText(envelope.error.reason) || !validEvidence(envelope.error.evidence)) throw new Error('scanner discovery error is invalid');
  return Object.freeze({ version: 1, ok: false, result: null, error: Object.freeze({ code: envelope.error.code, reason: envelope.error.reason, evidence: Object.freeze({ ...envelope.error.evidence }) }) });
}

export class ScannerDiscoveryService {
  #executable;
  #expectedSha256;
  #runner;
  #verify;

  constructor({ executable, expectedSha256, runner = runProcess, verifyExecutable } = {}) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0')) throw new TypeError('scanner helper executable is invalid');
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(expectedSha256)) throw new TypeError('scanner helper digest is invalid');
    if (typeof runner !== 'function' || typeof verifyExecutable !== 'function') throw new TypeError('scanner helper dependencies are invalid');
    this.#executable = executable; this.#expectedSha256 = expectedSha256.toLowerCase(); this.#runner = runner; this.#verify = verifyExecutable;
  }

  async discover({ signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    try {
      await this.#verify({ executable: this.#executable, expectedSha256: this.#expectedSha256 });
      const response = await this.#runner({ executable: this.#executable, args: [], stdin: REQUEST, signal, timeoutMs: 2_000, maxStdinBytes: REQUEST.length, maxStdoutBytes: MAX_FRAME_BYTES, maxStderrBytes: MAX_STDERR_BYTES });
      return parseEnvelope(response.stdout);
    } catch (error) {
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') {
        const cancelled = new Error('Scanner discovery was cancelled.'); cancelled.code = 'ENGINE_CANCELLED'; throw cancelled;
      }
      const failure = new Error('The scanner discovery helper failed its bounded contract.'); failure.code = 'SCANNER_DISCOVERY_FAILED'; throw failure;
    }
  }
}

export { parseEnvelope as parseScannerDiscoveryEnvelope };
