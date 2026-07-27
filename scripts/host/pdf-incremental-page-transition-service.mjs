import { createHash } from 'node:crypto';
import { chmod, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  normalizeIncrementalPageTransition,
} from './pdf-incremental-page-transition-contract.mjs';
import {
  inspectIncrementalPdfPageTransition,
  writeIncrementalPdfPageTransition,
} from './pdf-incremental-page-transition-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + 1024 * 1024;
const BEFORE_FILES = Object.freeze(['input.pdf']);
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
const CORE_METHODS = Object.freeze([
  'normalizeIncrementalPageTransition',
  'writeIncrementalPdfPageTransition',
  'inspectIncrementalPdfPageTransition',
]);
const DEFAULT_CORE = Object.freeze({
  normalizeIncrementalPageTransition,
  writeIncrementalPdfPageTransition,
  inspectIncrementalPdfPageTransition,
});
const LIMITATIONS = Object.freeze([
  'Only one classic, single-revision, unencrypted, unsigned, non-compressed PDF revision is accepted.',
  'Only the PDF /Dissolve transition profile is authored; page display duration, viewer-specific behavior, and other transition styles are not supported.',
  'The operation appends a revision and changes only selected page dictionaries by adding /Trans. Historical source bytes remain present and this is not signature preservation or broad viewer equivalence.',
]);
const VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'classic-single-revision-proof',
  'raw-transition-reinspection', 'page-topology-preserved', 'page-content-boxes-resources-annotations-preserved',
  'artifact-sha256',
]);

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}
function checkedCore(core) {
  if (!core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfIncrementalPageTransitionService requires the fixed raw page-transition core API.');
  return core;
}
function checkedRequest(core, value) {
  try { return core.normalizeIncrementalPageTransition(value); } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_PAGE_TRANSITION') fail('INVALID_INCREMENTAL_PAGE_TRANSITION_OPTIONS', 'The requested page transition is invalid.', 400, error);
    throw error;
  }
}
function throwIfAborted(signal) { if (signal.aborted) throw signal.reason ?? new Error('Incremental page-transition processing was cancelled.'); }
function overlap(left, right) {
  return left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}
async function workspaceShape(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) fail('INCREMENTAL_PAGE_TRANSITION_WORKSPACE_INVALID', 'Page-transition processing changed its private workspace topology.');
  for (const entry of entries) {
    const stat = await lstat(join(workspace, entry));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('INCREMENTAL_PAGE_TRANSITION_WORKSPACE_INVALID', 'Page-transition processing produced an unsafe workspace file.');
  }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The raw page-transition writer did not return a bounded PDF buffer.');
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400);
  } catch (error) {
    await handle?.close().catch(() => {}); await unlink(path).catch(() => {});
    fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The page-transition output could not be staged privately.', 502, error);
  }
}
async function readPrivate(path, { source = false } = {}) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('INCREMENTAL_PAGE_TRANSITION_WORKSPACE_INVALID', 'A page-transition workspace file is unsafe.');
  const bytes = await readFile(path);
  if (!Buffer.isBuffer(bytes) || bytes.length < (source ? 5 : 64) || bytes.length > (source ? MAX_SOURCE_BYTES : MAX_OUTPUT_BYTES)) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The page-transition workspace PDF is outside its fixed size bounds.');
  return bytes;
}
function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) return new HostError('INCREMENTAL_PAGE_TRANSITION_TIMEOUT', 'Incremental page-transition processing exceeded its two-minute deadline.', 504, { cause: error });
  if (externalSignal?.aborted) return new HostError('JOB_CANCELLED', 'Incremental page-transition processing was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'INVALID_INCREMENTAL_PAGE_TRANSITION') return new HostError('INVALID_INCREMENTAL_PAGE_TRANSITION_OPTIONS', 'The requested page transition is invalid.', 400, { cause: error });
  if (error?.code === 'UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF') return new HostError('INCREMENTAL_PAGE_TRANSITION_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded page-transition subset.', 422, { cause: error });
  if (error?.code === 'INVALID_INCREMENTAL_PAGE_TRANSITION_OUTPUT') return new HostError('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The append-only page-transition output failed separate raw reinspection.', 502, { cause: error });
  return new HostError('INCREMENTAL_PAGE_TRANSITION_FAILED', 'The local host could not create a verified append-only page-transition copy.', 502, { cause: error });
}
async function cleanup({ store, workspaces, promotedArtifact, completed }) {
  const results = await Promise.allSettled(workspaces.reverse().map((workspace) => Promise.resolve().then(() => store.cleanupJob(workspace))));
  const workspaceFailed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!completed || workspaceFailed) && promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(promotedArtifact.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) fail('INCREMENTAL_PAGE_TRANSITION_CLEANUP_FAILED', 'Incremental page-transition processing could not clean its private workspace or artifact.', 500);
}
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }

export class PdfIncrementalPageTransitionService {
  #store; #core;
  constructor({ store, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfIncrementalPageTransitionService requires a DocumentStore-compatible store.');
    this.#store = store; this.#core = checkedCore(core);
  }
  async update(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = checkedRequest(this.#core, value);
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The page-transition source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_SOURCE_BYTES) fail('INCREMENTAL_PAGE_TRANSITION_INPUT_TOO_LARGE', 'Page-transition editing is limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(externalSignal, MAX_JOB_MS); const workspaces = [];
    let sourceBytes = null; let writtenBytes = null; let outputBytes = null; let promotedArtifact = null; let completed = false;
    try {
      throwIfAborted(deadline.signal); await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId); workspaces.push(workspace);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
      await workspaceShape(workspace, BEFORE_FILES);
      sourceBytes = await readPrivate(inputPath, { source: true });
      throwIfAborted(deadline.signal);
      const written = await this.#core.writeIncrementalPdfPageTransition(sourceBytes, request);
      writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(writtenBytes) || overlap(writtenBytes, sourceBytes) || !written?.proof) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The raw page-transition writer returned an invalid result.');
      if (!writtenBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The raw page-transition writer changed the source prefix.');
      await writePrivateOutput(outputPath, writtenBytes); writtenBytes.fill(0); writtenBytes = null;
      await workspaceShape(workspace, AFTER_FILES);
      outputBytes = await readPrivate(outputPath);
      const proof = this.#core.inspectIncrementalPdfPageTransition(sourceBytes, outputBytes, request);
      if (!proof || proof.profile !== INCREMENTAL_PAGE_TRANSITION_PROFILE
        || !isDeepStrictEqual(written.proof, proof)
        || !isDeepStrictEqual(proof, this.#core.inspectIncrementalPdfPageTransition(sourceBytes, outputBytes, request))) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'Separate raw page-transition reinspection was unstable.');
      if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The re-inspected page-transition output changed the source prefix.');
      await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
      await this.#store.verifySource(documentId); throwIfAborted(deadline.signal);
      const outputDigest = createHash('sha256').update(outputBytes).digest('hex');
      if (outputDigest === source.sha256) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The page-transition output did not produce a distinct artifact digest.');
      const operation = createOperationProvenance({
        type: 'pdf-incremental-page-transition',
        inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: request,
        expected: { selectedPages: request.pages, sourceUnchanged: true, sourcePrefixPreserved: true, onlySelectedPagesChanged: true, pageDictionariesPreserved: true, rasterized: false },
        validation: { passed: true, validators: VALIDATORS, outputSha256: outputDigest, profile: INCREMENTAL_PAGE_TRANSITION_PROFILE },
      });
      const stem = basename(source.displayName, extname(source.displayName));
      const artifact = await this.#store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-page-transition.pdf`, operation, expectedSha256: outputDigest, signal: deadline.signal });
      promotedArtifact = { artifact };
      if (!artifact || artifact.sha256 !== outputDigest || artifact.id === source.id) fail('INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID', 'The promoted page-transition artifact does not match the validated output.');
      throwIfAborted(deadline.signal); completed = true;
      return freeze({ kind: 'pdf-incremental-page-transition', sourceDigest: source.sha256, artifact, transition: { pages: request.pages, style: request.transition, duration: request.duration }, evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, rawReinspectionPassed: true, pageTopologyPreserved: true, pageContentBoxesResourcesAnnotationsPreserved: true, onlySelectedPagesChanged: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }, limitations: LIMITATIONS });
    } catch (error) { throw mapFailure(error, externalSignal, deadline); }
    finally {
      deadline.dispose(); sourceBytes?.fill(0); writtenBytes?.fill(0); outputBytes?.fill(0);
      await cleanup({ store: this.#store, workspaces, promotedArtifact, completed });
    }
  }
}
export function createPdfIncrementalPageTransitionService(options) { return new PdfIncrementalPageTransitionService(options); }
export const PdfPageTransitionService = PdfIncrementalPageTransitionService;
export function createPdfPageTransitionService(options) { return new PdfIncrementalPageTransitionService(options); }
