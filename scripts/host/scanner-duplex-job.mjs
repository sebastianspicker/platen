import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HostError } from './host-error.mjs';
import { runProcess } from './process-runner.mjs';
import { readStableOutput } from './scanner-acquisition-service.mjs';
import {
  parseScannerDuplexEnvelope,
  validateScannerDuplexOptions,
} from './scanner-duplex-contract.mjs';

const MAX_FRAME_BYTES = 32 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024;

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function parseResponse(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_FRAME_BYTES) {
    throw host('SCANNER_DUPLEX_PROTOCOL_INVALID', 'The duplex helper response exceeded its bounded frame.', 502);
  }
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw host('SCANNER_DUPLEX_PROTOCOL_INVALID', 'The duplex helper must emit exactly one response frame.', 502);
  }
  let body;
  try { body = JSON.parse(lines[0]); }
  catch (error) {
    throw host('SCANNER_DUPLEX_PROTOCOL_INVALID', 'The duplex helper response was not valid JSON.', 502, error);
  }
  try { return parseScannerDuplexEnvelope(body); }
  catch (error) {
    throw host('SCANNER_DUPLEX_PROTOCOL_INVALID', 'The duplex helper response violated its pinned contract.', 502, error);
  }
}

export class ScannerDuplexJob {
  #executable; #expectedSha256; #runner; #verify; #workspaceRoot; #removeWorkspace;

  constructor({
    executable,
    expectedSha256,
    runner = runProcess,
    verifyExecutable,
    workspaceRoot,
    removeWorkspace = rm,
  } = {}) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0')) {
      throw new TypeError('scanner duplex helper executable is invalid');
    }
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(expectedSha256)) {
      throw new TypeError('scanner duplex helper digest is invalid');
    }
    if (typeof runner !== 'function' || typeof verifyExecutable !== 'function'
      || typeof removeWorkspace !== 'function') throw new TypeError('scanner duplex job dependencies are invalid');
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/')
      || workspaceRoot.includes('\0')) throw new TypeError('scanner duplex workspace root is invalid');
    this.#executable = executable;
    this.#expectedSha256 = expectedSha256.toLowerCase();
    this.#runner = runner;
    this.#verify = verifyExecutable;
    this.#workspaceRoot = resolve(workspaceRoot);
    this.#removeWorkspace = removeWorkspace;
  }

  async run(value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    const request = validateScannerDuplexOptions(value);
    if (signal?.aborted) throw host('JOB_CANCELLED', 'Duplex feeder acquisition was cancelled.', 499);
    let workspace = null;
    let output = null;
    try {
      await this.#verify({ executable: this.#executable, expectedSha256: this.#expectedSha256 });
      workspace = await mkdtemp(join(this.#workspaceRoot, 'scanner-duplex-'));
      await chmod(workspace, 0o700);
      const payload = {
        version: 1, operation: 'scanDuplex', deviceId: request.deviceId,
        destination: workspace, maxBytes: request.maxBytes, maxPixels: request.maxPixels,
        deadlineMs: request.deadlineMs, format: request.format, source: request.source,
        duplex: true, color: request.color, dpi: request.dpi, pageCount: request.pageCount,
      };
      const frame = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
      if (frame.length > MAX_REQUEST_BYTES) {
        throw host('SCANNER_DUPLEX_PROTOCOL_INVALID', 'The duplex helper request exceeded its bounded frame.', 500);
      }
      const response = await this.#runner({
        executable: this.#executable, args: [], stdin: frame, signal,
        timeoutMs: request.deadlineMs, maxStdinBytes: MAX_REQUEST_BYTES,
        maxStdoutBytes: MAX_FRAME_BYTES, maxStderrBytes: MAX_STDERR_BYTES,
      });
      const envelope = parseResponse(response.stdout);
      if (!envelope.ok) {
        const error = host(envelope.error.code, envelope.error.reason, 503);
        error.evidence = envelope.error.evidence;
        throw error;
      }
      if (envelope.result.pageCount !== request.pageCount
        || envelope.result.bytes > request.maxBytes
        || envelope.result.totalPixels > request.maxPixels) {
        throw host('SCANNER_DUPLEX_OUTPUT_INVALID', 'The duplex helper exceeded the exact requested bounds.', 502);
      }
      const files = await readdir(workspace, { withFileTypes: true });
      if (files.length !== 1 || files[0].name !== 'duplex-scan.pdf' || !files[0].isFile()) {
        throw host('SCANNER_DUPLEX_OUTPUT_INVALID', 'The duplex workspace must contain one regular PDF output.', 502);
      }
      output = await readStableOutput(join(workspace, 'duplex-scan.pdf'), workspace,
        'duplex-scan.pdf', request.maxBytes, signal);
      if (output.size !== envelope.result.bytes || output.sha256 !== envelope.result.digest) {
        throw host('SCANNER_DUPLEX_OUTPUT_INVALID', 'The duplex helper digest did not match its private PDF.', 502);
      }
      return {
        bytes: output.bytes,
        sha256: output.sha256,
        size: output.size,
        request,
        helperReportedPages: envelope.result.pages,
        evidence: envelope.result.evidence,
      };
    } catch (error) {
      output?.bytes?.fill(0);
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') {
        throw host('JOB_CANCELLED', 'Duplex feeder acquisition was cancelled.', 499, error);
      }
      if (error?.code === 'ENGINE_TIMEOUT') {
        throw host('SCANNER_DUPLEX_TIMEOUT', 'Duplex feeder acquisition exceeded its deadline.', 504, error);
      }
      if (error instanceof HostError) throw error;
      throw host('SCANNER_DUPLEX_FAILED', 'The pinned duplex helper could not complete acquisition.', 502, error);
    } finally {
      if (workspace) {
        try { await this.#removeWorkspace(workspace, { recursive: true, force: false }); }
        catch (error) {
          output?.bytes?.fill(0);
          throw host('SCANNER_DUPLEX_CLEANUP_FAILED', 'The duplex job could not remove its private workspace.', 500, error);
        }
      }
    }
  }
}

export { parseResponse as parseScannerDuplexResponse };
