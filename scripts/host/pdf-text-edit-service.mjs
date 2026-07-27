import { createHash } from 'node:crypto';
import { chmod, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { parseTextPages, readRegularOutput } from './pdf-service-foundation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { normalizePdfTextEditRequest, PDF_TEXT_EDIT_PROFILE } from './pdf-text-edit-contract.mjs';
import { inspectPdfTextEdit, writePdfTextEdit } from './pdf-text-edit-writer.mjs';

const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (1024 * 1024);
const SHA256 = /^[0-9a-f]{64}$/u;
const CORE = Object.freeze({ normalizePdfTextEditRequest, writePdfTextEdit, inspectPdfTextEdit });
const METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob',
  'promotePdfArtifact', 'deleteArtifact',
]);
const BEFORE_FILES = Object.freeze(['input.pdf']);
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}
function fail(code, message, status = 502, cause) { throw host(code, message, status, cause); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function checkedSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
}
function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('PDF text editing was cancelled.');
}
function checkedRequest(core, value, sourceSha256) {
  try {
    const normalized = core.normalizePdfTextEditRequest(value);
    if (normalized.sourceSha256 !== undefined && normalized.sourceSha256 !== sourceSha256) {
      throw host('SOURCE_VERSION_MISMATCH', 'The PDF text-edit request digest does not match the current document.', 409);
    }
    return core.normalizePdfTextEditRequest({ ...normalized, sourceSha256 });
  } catch (error) {
    if (error?.code === 'INVALID_PDF_TEXT_EDIT') throw host('PDF_TEXT_EDIT_OPTIONS_INVALID', 'The PDF text-edit options are invalid.', 400, error);
    throw error;
  }
}
async function workspaceSafe(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) fail('PDF_TEXT_EDIT_WORKSPACE_INVALID', 'PDF text editing changed its private workspace topology.');
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) fail('PDF_TEXT_EDIT_WORKSPACE_INVALID', 'PDF text editing produced an unsafe workspace file.');
  }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) fail('PDF_TEXT_EDIT_OUTPUT_INVALID', 'The raw text-edit output is not bounded.');
  let handle;
  try {
    handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400);
  } catch (error) {
    await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('PDF_TEXT_EDIT_OUTPUT_INVALID', 'The text-edit output could not be staged privately.', 502, error);
  }
}
async function readPdf(path, source = false) {
  return readRegularOutput(path, { minimumBytes: source ? 5 : 64, maximumBytes: source ? MAX_SOURCE_BYTES : MAX_OUTPUT_BYTES, label: source ? 'Private text-edit source' : 'Text-edit PDF output' });
}
function requireSilent(results) {
  if (results.some((result) => String(result?.stderr ?? '').trim())) fail('PDF_TEXT_EDIT_POPPLER_WARNING', 'Poppler reported a warning while validating the text-edit output.', 422);
}
async function popplerText(poppler, input, workspace, signal) {
  const result = await poppler.execute('extractText', { input, layout: true }, { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 256 * 1024 });
  requireSilent([result]);
  return parseTextPages(result.stdout);
}
function textMatches(sourcePages, outputPages, request) {
  if (!Array.isArray(sourcePages) || !Array.isArray(outputPages) || sourcePages.length !== outputPages.length) return false;
  for (let index = 0; index < sourcePages.length; index += 1) {
    const source = sourcePages[index]?.text;
    const output = outputPages[index]?.text;
    if (typeof source !== 'string' || typeof output !== 'string') return false;
    if (index !== request.page - 1) { if (source !== output) return false; continue; }
    const first = source.indexOf(request.find);
    if (first < 0 || first !== source.lastIndexOf(request.find)) return false;
    const expected = `${source.slice(0, first)}${request.replace}${source.slice(first + request.find.length)}`;
    if (output !== expected) return false;
  }
  return true;
}
function mapError(error, signal, deadline) {
  if (deadline.timedOut) return host('PDF_TEXT_EDIT_TIMEOUT', 'PDF text editing exceeded its two-minute deadline.', 504, error);
  if (signal?.aborted) return host('JOB_CANCELLED', 'PDF text editing was cancelled.', 499, error);
  if (error instanceof HostError) return error;
  if (error?.code === 'UNSUPPORTED_PDF_TEXT_EDIT') return host('PDF_TEXT_EDIT_SOURCE_UNSUPPORTED', 'The PDF is outside the bounded literal text-edit subset.', 422, error);
  if (error?.code === 'INVALID_PDF_TEXT_EDIT') return host('PDF_TEXT_EDIT_OPTIONS_INVALID', 'The PDF text-edit options are invalid.', 400, error);
  if (error?.code === 'INVALID_PDF_TEXT_EDIT_OUTPUT') return host('PDF_TEXT_EDIT_OUTPUT_INVALID', 'The text-edit output failed deterministic validation.', 502, error);
  return host('PDF_TEXT_EDIT_FAILED', 'The local host could not create a verified PDF text-edit artifact.', 502, error);
}

export const PDF_TEXT_EDIT_LIMITATIONS = Object.freeze([
  'Only one exact, uniquely occurring, unescaped printable-ASCII literal shown with Tj in one unfiltered passive page stream is supported.',
  'The replacement must have the same encoded byte length; arrays, hex strings, escapes, reflow, and general typography are unsupported.',
  'Unsigned, unencrypted, untagged, form-free, action-free, layer-free single-revision PDFs are required.',
]);

export class PdfTextEditService {
  #store; #poppler; #core;
  constructor({ store, poppler, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfTextEditService requires a DocumentStore-compatible store.');
    if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('PdfTextEditService requires a Poppler adapter.');
    if (!core || ['normalizePdfTextEditRequest', 'writePdfTextEdit', 'inspectPdfTextEdit'].some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfTextEditService requires the fixed PDF text-edit core API.');
    this.#store = store; this.#poppler = poppler; this.#core = core;
  }

  async edit(documentId, value, { sourceSha256, signal } = {}) {
    checkedSignal(signal);
    const source = this.#store.getDocument(documentId);
    if (!source || !SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The PDF text-edit source digest does not match the current document.', 409);
    const request = checkedRequest(this.#core, value, source.sha256);
    const deadline = createDeadline(signal, MAX_JOB_MS);
    const lifecycle = { workspaces: [], sourceBytes: null, writtenBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try {
      throwIfAborted(deadline.signal); await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal });
      await workspaceSafe(workspace, BEFORE_FILES);
      lifecycle.sourceBytes = await readPdf(inputPath, true); throwIfAborted(deadline.signal);
      const written = await this.#core.writePdfTextEdit(lifecycle.sourceBytes, request);
      lifecycle.writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(lifecycle.writtenBytes) || !written?.proof || !lifecycle.writtenBytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) fail('PDF_TEXT_EDIT_OUTPUT_INVALID', 'The raw text-edit writer returned an invalid output.');
      await writePrivateOutput(outputPath, lifecycle.writtenBytes); lifecycle.writtenBytes.fill(0); lifecycle.writtenBytes = null;
      await workspaceSafe(workspace, AFTER_FILES);
      lifecycle.outputBytes = await readPdf(outputPath); const outputDigest = digest(lifecycle.outputBytes);
      const reinspection = await this.#core.inspectPdfTextEdit(lifecycle.sourceBytes, lifecycle.outputBytes, request);
      if (!reinspection || reinspection.outputSha256 !== outputDigest || reinspection.sourceSha256 !== source.sha256) fail('PDF_TEXT_EDIT_OUTPUT_INVALID', 'Independent text-edit reinspection did not match the staged output.');
      const [sourcePages, outputPages] = await Promise.all([popplerText(this.#poppler, inputPath, workspace, deadline.signal), popplerText(this.#poppler, outputPath, workspace, deadline.signal)]);
      if (!textMatches(sourcePages, outputPages, request)) fail('PDF_TEXT_EDIT_OUTPUT_INVALID', 'Poppler text differed outside the exact requested replacement.', 502);
      await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
      await this.#store.verifySource(documentId); throwIfAborted(deadline.signal);
      const stem = basename(source.displayName ?? 'document.pdf', extname(source.displayName ?? 'document.pdf'));
      const operation = createOperationProvenance({ type: 'pdf-text-edit', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_TEXT_EDIT_PROFILE, page: request.page, findSha256: digest(Buffer.from(request.find, 'ascii')), replaceSha256: digest(Buffer.from(request.replace, 'ascii')) }, expected: { outputSha256: outputDigest, sourcePrefixPreserved: true, replacementCount: 1 }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'raw-text-edit-writer', 'independent-text-edit-reinspection', 'poppler-pdftotext-exact-change', 'artifact-sha256'], outputSha256: outputDigest } });
      lifecycle.promotedArtifact = await this.#store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-text-edit.pdf`, operation, expectedSha256: outputDigest, signal: deadline.signal });
      if (!lifecycle.promotedArtifact?.sha256 || lifecycle.promotedArtifact.sha256 !== outputDigest || lifecycle.promotedArtifact.id === source.id) fail('PDF_TEXT_EDIT_OUTPUT_INVALID', 'The promoted text-edit artifact did not match the validated output.');
      throwIfAborted(deadline.signal); lifecycle.completed = true;
      return Object.freeze({ kind: 'pdf-text-edit', artifact: lifecycle.promotedArtifact, proof: reinspection, limitations: PDF_TEXT_EDIT_LIMITATIONS });
    } catch (error) { throw mapError(error, signal, deadline); }
    finally {
      deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.writtenBytes?.fill(0); lifecycle.outputBytes?.fill(0);
      const cleanup = await Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => this.#store.cleanupJob(workspace)));
      let artifactFailure = false;
      if ((!lifecycle.completed || cleanup.some(({ status }) => status === 'rejected')) && lifecycle.promotedArtifact?.id) { try { await this.#store.deleteArtifact(lifecycle.promotedArtifact.id); } catch { artifactFailure = true; } }
      if (cleanup.some(({ status }) => status === 'rejected') || artifactFailure) throw host('PDF_TEXT_EDIT_CLEANUP_FAILED', 'PDF text editing could not clean its private workspace or derived artifact.', 500);
    }
  }
  async replace(documentId, value, options = {}) { return this.edit(documentId, value, options); }
  async findReplace(documentId, value, options = {}) { return this.edit(documentId, value, options); }
}

export function createPdfTextEditService(options) { return new PdfTextEditService(options); }
export const createPdfFindReplaceService = createPdfTextEditService;
