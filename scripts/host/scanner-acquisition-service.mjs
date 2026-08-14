import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { runProcess } from './process-runner.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { HostError } from './host-error.mjs';
import {
  SCANNER_ACQUISITION_MAX_BYTES,
  parseScannerAcquisitionEnvelope,
  validateScannerAcquisitionOptions,
} from './scanner-acquisition-contract.mjs';

const MAX_FRAME_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const REQUEST_BYTES = 4 * 1024;
const PDF_PREFIX = Buffer.from('%PDF-', 'ascii');

function host(code, message, status = 400, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safeSnapshot(value, seen = new Set(), depth = 0) {
  if (depth > 12 || value === null || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return null;
  if (typeof value !== 'object') return typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value) ? value : null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length || !descriptors.length || descriptors.length.enumerable || descriptors.length.get || descriptors.length.set || Object.keys(value).length !== value.length) return null;
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        const child = safeSnapshot(descriptor.value, seen, depth + 1); if (child === null && descriptor.value !== null) return null; output.push(child);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value); const output = Object.create(null);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const child = safeSnapshot(descriptor.value, seen, depth + 1); if (child === null && descriptor.value !== null) return null; output[key] = child;
    }
    return output;
  } catch { return null; }
  finally { seen.delete(value); }
}

function sameJson(left, right) {
  const leftSnapshot = safeSnapshot(left); const rightSnapshot = safeSnapshot(right);
  try { return leftSnapshot !== null && rightSnapshot !== null && JSON.stringify(leftSnapshot) === JSON.stringify(rightSnapshot); } catch { return false; }
}

function documentRecord(value) {
  const snapshot = safeSnapshot(value);
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
}

function parseEnvelope(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_FRAME_BYTES) throw host('SCANNER_ACQUISITION_FAILED', 'The scanner helper response exceeded its bounded frame.', 502);
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1) throw host('SCANNER_ACQUISITION_FAILED', 'The scanner helper must emit exactly one response frame.', 502);
  let body;
  try { body = JSON.parse(lines[0]); } catch (error) { throw host('SCANNER_ACQUISITION_FAILED', 'The scanner helper response was not valid JSON.', 502, error); }
  try { return parseScannerAcquisitionEnvelope(body); } catch (error) { throw host('SCANNER_ACQUISITION_FAILED', 'The scanner helper response violated its versioned contract.', 502, error); }
}

function privateOutputMetadata(value, workspace, expectedName, maxBytes) {
  if (!value || value.isSymbolicLink() || !value.isFile() || value.nlink !== 1n || value.size < PDF_PREFIX.length || value.size > maxBytes || (value.mode & 0o777n) !== 0o600n) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner helper did not produce a bounded private PDF output.', 502);
  const expected = resolve(workspace, expectedName);
  if (!expected.startsWith(`${resolve(workspace)}${sep}`)) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output escaped its private workspace.', 502);
}

async function readStableOutput(path, workspace, expectedName, maxBytes, signal) {
  let handle;
  try {
    const before = await stat(path, { bigint: true });
    privateOutputMetadata(before, workspace, expectedName, maxBytes);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1n) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output changed before it could be read.', 502);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Scanner acquisition was cancelled.', 499);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (bytesRead < 1) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output ended while it was being read.', 502);
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output grew while it was being read.', 502);
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output changed while it was being read.', 502);
    if (!bytes.subarray(0, PDF_PREFIX.length).equals(PDF_PREFIX)) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output is not a PDF.', 502);
    return Object.freeze({ bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  } catch (error) {
    if (error instanceof HostError) throw error;
    if (['ENOENT', 'ELOOP', 'ENXIO'].includes(error?.code)) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output was unavailable or unsafe.', 502, error);
    throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner output could not be read safely.', 502, error);
  } finally { await handle?.close().catch(() => {}); }
}

export class ScannerAcquisitionService {
  #executable; #expectedSha256; #runner; #verify; #workspaceRoot; #store; #removeWorkspace;

  constructor({ executable, expectedSha256, runner = runProcess, verifyExecutable, workspaceRoot, store, removeWorkspace = rm } = {}) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0')) throw new TypeError('scanner helper executable is invalid');
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(expectedSha256)) throw new TypeError('scanner helper digest is invalid');
    if (typeof runner !== 'function' || typeof verifyExecutable !== 'function') throw new TypeError('scanner helper dependencies are invalid');
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/') || workspaceRoot.includes('\0')) throw new TypeError('scanner acquisition workspace root is invalid');
    if (!store || typeof store.createDocument !== 'function' || typeof store.deleteDocument !== 'function' || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') throw new TypeError('scanner acquisition requires a source-free document store boundary');
    if (typeof removeWorkspace !== 'function') throw new TypeError('scanner acquisition cleanup dependency is invalid');
    this.#executable = executable; this.#expectedSha256 = expectedSha256.toLowerCase(); this.#runner = runner; this.#verify = verifyExecutable; this.#workspaceRoot = resolve(workspaceRoot); this.#store = store; this.#removeWorkspace = removeWorkspace;
  }

  async acquire(value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    const request = validateScannerAcquisitionOptions(value);
    if (signal?.aborted) throw host('JOB_CANCELLED', 'Scanner acquisition was cancelled.', 499);
    let workspace = null;
    let output = null;
    let retained = null;
    let operationError = null;
    let cleanupError = null;
    try {
      await this.#verify({ executable: this.#executable, expectedSha256: this.#expectedSha256 });
      workspace = await mkdtemp(join(this.#workspaceRoot, 'scanner-acquisition-'));
      await chmod(workspace, 0o700);
      const frame = Buffer.from(`${JSON.stringify({ version: 1, operation: 'scan', deviceId: request.deviceId, destination: workspace, page: 1, maxBytes: request.maxBytes, deadlineMs: request.deadlineMs, format: request.format, source: request.source, duplex: request.duplex, color: request.color, dpi: request.dpi, pageCount: request.pageCount })}\n`, 'utf8');
      const response = await this.#runner({ executable: this.#executable, args: [], stdin: frame, signal, timeoutMs: request.deadlineMs, maxStdinBytes: REQUEST_BYTES, maxStdoutBytes: MAX_FRAME_BYTES, maxStderrBytes: MAX_STDERR_BYTES });
      const envelope = parseEnvelope(response.stdout);
      if (!envelope.ok) {
        const error = host(envelope.error.code, envelope.error.reason, 503);
        error.evidence = envelope.error.evidence;
        throw error;
      }
      if (envelope.result.bytes > request.maxBytes) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner helper output exceeded the requested byte limit.', 502);
      const outputPath = join(workspace, envelope.result.outputName);
      const files = await readdir(workspace, { withFileTypes: true });
      if (files.length !== 1 || files[0].name !== 'scan.pdf' || !files[0].isFile()) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner workspace must contain exactly one regular scan.pdf output.', 502);
      output = await readStableOutput(outputPath, workspace, envelope.result.outputName, request.maxBytes, signal);
      if (output.size !== envelope.result.bytes || output.sha256 !== envelope.result.digest) throw host('SCANNER_ACQUISITION_OUTPUT_INVALID', 'The scanner helper digest did not match its private PDF output.', 502);
      const operation = createOperationProvenance({
        type: 'scan-acquire', inputs: [],
        parameters: { profile: request.profile, deviceId: request.deviceId, source: request.source, duplex: false, color: request.color, dpi: request.dpi, pageCount: 1, format: 'PDF' },
        expected: { pageCount: 1, outputSha256: output.sha256, sourceFree: true },
        validation: { passed: true, validators: ['pinned-helper-sha256', 'private-workspace', 'scanner-output-identity', 'scanner-output-digest', 'pdf-header', 'single-page-acquisition'], outputSha256: output.sha256 },
      });
      const document = await this.#store.createDocument({ stream: Readable.from([output.bytes]), displayName: 'scan.pdf', mediaType: 'application/pdf', operation });
      const documentValue = documentRecord(document);
      if (!documentValue || !DOCUMENT_ID.test(documentValue.id ?? '') || documentValue.mediaType !== 'application/pdf' || documentValue.size !== output.size || documentValue.sha256 !== output.sha256 || documentValue.origin !== 'derived' || !sameJson(documentValue.operation, operation)) throw host('SCANNER_ACQUISITION_DOCUMENT_INVALID', 'The document store returned a document that was not bound to the acquired PDF.', 502);
      retained = Object.freeze({ id: documentValue.id, document: documentValue });
      const retainedDocument = this.#store.getDocument(documentValue.id);
      const retainedValue = documentRecord(retainedDocument);
      if (!retainedValue || retainedValue.id !== documentValue.id || retainedValue.mediaType !== 'application/pdf' || retainedValue.size !== output.size || retainedValue.sha256 !== output.sha256 || retainedValue.origin !== 'derived' || !sameJson(retainedValue.operation, operation)) throw host('SCANNER_ACQUISITION_DOCUMENT_INVALID', 'The retained scan document could not be revalidated against its private output.', 502);
      await this.#store.verifySource(documentValue.id);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Scanner acquisition was cancelled.', 499);
      output.bytes.fill(0);
      output = null;
      return Object.freeze({ kind: 'scan-acquire', document: Object.freeze(documentValue), operation, evidence: Object.freeze({ sourceFree: true, pageCount: 1, helperVerified: true, outputDigestBound: true, localOnly: true }) });
    } catch (error) {
      operationError = signal?.aborted || error?.code === 'ENGINE_CANCELLED'
        ? host('JOB_CANCELLED', 'Scanner acquisition was cancelled.', 499, error)
        : error instanceof HostError ? error : host('SCANNER_ACQUISITION_FAILED', 'The local scanner helper could not complete a validated acquisition.', 502, error);
      throw operationError;
    } finally {
      output?.bytes?.fill(0);
      if (workspace) {
        try { await this.#removeWorkspace(workspace, { recursive: true, force: false }); }
        catch (error) { cleanupError = host('SCANNER_ACQUISITION_CLEANUP_FAILED', 'Scanner acquisition could not remove its private workspace.', 500, error); }
      }
      let revokeError = null;
      if (retained?.id && (operationError || cleanupError)) {
        try { await this.#store.deleteDocument(retained.id); }
        catch (error) { revokeError = error; }
      }
      if (cleanupError || revokeError) {
        if (revokeError) throw host('SCANNER_ACQUISITION_CLEANUP_FAILED', 'Scanner acquisition could not remove its private workspace or revoke its trusted document.', 500, new AggregateError([cleanupError, revokeError]));
        if (operationError && cleanupError) throw host('SCANNER_ACQUISITION_CLEANUP_FAILED', 'Scanner acquisition failed and could not remove its private workspace.', 500, new AggregateError([operationError, cleanupError]));
        throw cleanupError;
      }
    }
  }
}

export { parseEnvelope as parseScannerAcquisitionResponse, readStableOutput };
