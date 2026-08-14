import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { HostError } from './host-error.mjs';
import {
  createDeadline, executeOfflineSignatureInspection, PNG_SIGNATURE, readRegularOutput,
} from './pdf-service-foundation.mjs';
import {
  inspectIncrementalMetadataContent, inspectIncrementalMetadataEnvelope,
  incrementalMetadataEnvelopeSupported, incrementalMetadataRunOptions,
} from './pdf-incremental-metadata-validation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { decodePng } from './raster-png-codec.mjs';
import { parsePdfStructure } from './pdf-classic-structure.mjs';
import {
  FULL_PAGE_REDACTION_PROFILE, writeFullPageRedaction,
  FULL_PAGE_REDACTION_BATCH_PROFILE, writeFullPageRedactionBatch,
} from './pdf-full-page-redaction-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (1024 * 1024);
const BEFORE_FILES = Object.freeze(['input.pdf']);
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
const STORE_METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE_METHODS = Object.freeze(['writeFullPageRedaction']);
const DEFAULT_CORE = Object.freeze({ writeFullPageRedaction, writeFullPageRedactionBatch });

export const PDF_FULL_PAGE_REDACTION_LIMITATIONS = Object.freeze([
  'Only one full-page target in a bounded, unsigned, unencrypted, passive PDF is supported.',
  'The target page content and reachable resources are replaced in a closed compact rewrite; this is not region redaction.',
  'This operation does not claim whole-document sanitization, signature preservation, PDF/A, PDF/UA, PDF/X, or print-production equivalence.',
]);
export const PDF_FULL_PAGE_REDACTION_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-closed-redaction-proof',
  'poppler-page-count-text-boxes', 'poppler-target-text-empty',
  'poppler-target-render-black', 'poppler-nontarget-text-render-equality',
  'pdfsig-output-unsigned', 'attachments-and-urls-absent', 'artifact-sha256',
]);

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal.aborted) throw signal.reason ?? new Error('Full-page redaction was cancelled.'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }
function checkedCore(core) { if (!core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfFullPageRedactionService requires the raw full-page redaction writer.'); return core; }
function checkedRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || value.profile !== FULL_PAGE_REDACTION_PROFILE || !SHA256.test(value.sourceSha256 ?? '')
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 100) {
    fail('INVALID_FULL_PAGE_REDACTION_OPTIONS', 'The full-page redaction request is invalid.', 400);
  }
  return Object.freeze({ profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256: value.sourceSha256, page: value.page });
}
function checkedBatchRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || value.profile !== FULL_PAGE_REDACTION_BATCH_PROFILE || !SHA256.test(value.sourceSha256 ?? '') || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 32 || value.pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 100) || value.pages.some((page, index) => index > 0 && page <= value.pages[index - 1])) fail('INVALID_FULL_PAGE_REDACTION_BATCH_OPTIONS', 'The full-page redaction batch request is invalid.', 400);
  return Object.freeze({ profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: value.sourceSha256, pages: Object.freeze([...value.pages]) });
}
function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) return new HostError('FULL_PAGE_REDACTION_TIMEOUT', 'Full-page redaction exceeded its two-minute deadline.', 504, { cause: error });
  if (externalSignal?.aborted) return new HostError('JOB_CANCELLED', 'Full-page redaction was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'UNSUPPORTED_FULL_PAGE_REDACTION') return new HostError('FULL_PAGE_REDACTION_SOURCE_UNSUPPORTED', 'The PDF is outside the supported passive full-page redaction subset.', 422, { cause: error });
  return new HostError('FULL_PAGE_REDACTION_FAILED', 'The local host could not create a verified full-page redaction copy.', 502, { cause: error });
}
async function workspaceSafe(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) fail('FULL_PAGE_REDACTION_WORKSPACE_INVALID', 'Full-page redaction changed its private workspace topology.');
  for (const entry of entries) { const metadata = await lstat(join(workspace, entry)); if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) fail('FULL_PAGE_REDACTION_WORKSPACE_INVALID', 'Full-page redaction produced an unsafe workspace file.'); }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The raw full-page redaction output is not bounded.');
  let handle = null;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); } catch (error) { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The full-page redaction output could not be staged privately.', 502, error); }
}
async function readPdf(path, source = false) { return readRegularOutput(path, { minimumBytes: source ? 5 : 64, maximumBytes: source ? MAX_SOURCE_BYTES : MAX_OUTPUT_BYTES, label: source ? 'Private full-page redaction source' : 'Full-page redaction PDF output' }); }
async function identity(path) { const metadata = await lstat(path, { bigint: true }); return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, metadata[key]]))); }
async function assertIdentity(path, expected) { const actual = await identity(path); if (IDENTITY_KEYS.some((key) => actual[key] !== expected[key])) fail('FULL_PAGE_REDACTION_WORKSPACE_INVALID', 'A full-page redaction workspace file changed during validation.'); }
async function snapshot({ poppler, input, workspace, signatureWorkspace, signal }) {
  const results = await Promise.allSettled([
    inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal }),
  ]);
  const rejected = results.find(({ status }) => status === 'rejected'); if (rejected) throw rejected.reason;
  const [envelope, signatures] = results.map(({ value }) => value);
  if (!incrementalMetadataEnvelopeSupported(envelope, signatures)) fail('FULL_PAGE_REDACTION_SOURCE_UNSUPPORTED', 'Full-page redaction requires an unsigned, unencrypted passive PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
  const content = await inspectIncrementalMetadataContent(poppler, input, workspace, signal, envelope.inspection.pageCount);
  return Object.freeze({ envelope, signatures, content });
}
async function render(poppler, input, prefix, workspace, signal, page) {
  const result = await poppler.execute('renderPagePng', { input, outputPrefix: prefix, page, maxDimension: 256 }, incrementalMetadataRunOptions(workspace, signal, 64 * 1024));
  if (String(result?.stderr ?? '').trim()) fail('FULL_PAGE_REDACTION_POPPLER_WARNING', 'Poppler reported a warning while validating the full-page redaction output.', 422);
  const bytes = await readRegularOutput(`${prefix}.png`, { minimumBytes: PNG_SIGNATURE.length, maximumBytes: 32 * 1024 * 1024, label: 'Full-page redaction validation render' });
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'Poppler produced an invalid full-page redaction render.');
  return bytes;
}
function assertBlack(bytes) {
  const image = decodePng(bytes); let black = 0;
  for (let offset = 0; offset < image.pixels.length; offset += 4) if (image.pixels[offset] <= 24 && image.pixels[offset + 1] <= 24 && image.pixels[offset + 2] <= 24 && image.pixels[offset + 3] >= 240) black += 1;
  if (black < image.width * image.height * 0.98) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The target page render was not black or near-black.');
}
async function assertRenders({ poppler, sourcePath, outputPath, workspace, signal, pageCount, targetPage }) {
  for (let page = 1; page <= pageCount; page += 1) {
    const sourcePrefix = join(workspace, `source-render-${page}`); const outputPrefix = join(workspace, `output-render-${page}`);
    try { const source = await render(poppler, sourcePath, sourcePrefix, workspace, signal, page); const output = await render(poppler, outputPath, outputPrefix, workspace, signal, page); if ((targetPage instanceof Set ? targetPage.has(page) : page === targetPage)) assertBlack(output); else if (!source.equals(output)) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', `Full-page redaction changed non-target page ${page}.`); } finally { await Promise.allSettled([unlink(`${sourcePrefix}.png`), unlink(`${outputPrefix}.png`)]); }
  }
}
function proofValid(proof, sourceLength, outputLength, request, outputDigest) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  return keys.length === 11 && keys.every((key, index) => key === ['profile', 'page', 'sourceSha256', 'closedRevision', 'sourcePrefixPreserved', 'priorRevisionsAbsent', 'cropBoxFilled', 'directEmptyResources', 'supersededReferencesAbsent', 'blackStreamObjectNumber', 'outputSha256'][index]) && proof.profile === request.profile && proof.page === request.page && proof.sourceSha256 === request.sourceSha256 && proof.closedRevision === true && proof.sourcePrefixPreserved === false && proof.priorRevisionsAbsent === true && proof.cropBoxFilled === true && proof.directEmptyResources === true && proof.supersededReferencesAbsent === true && Number.isSafeInteger(proof.blackStreamObjectNumber) && proof.blackStreamObjectNumber > 0 && proof.outputSha256 === outputDigest && outputLength >= 64 && sourceLength >= 5;
}
function batchProofValid(proof, sourceLength, outputLength, request, outputDigest) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const expectedKeys = ['profile', 'pages', 'sourceSha256', 'closedRevision', 'sourcePrefixPreserved', 'priorRevisionsAbsent', 'targets', 'supersededReferences', 'supersededReferencesAbsent', 'outputSha256'];
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) return false;
  if (proof.profile !== request.profile || !isDeepStrictEqual(proof.pages, request.pages) || proof.sourceSha256 !== request.sourceSha256
    || proof.closedRevision !== true || proof.sourcePrefixPreserved !== false || proof.priorRevisionsAbsent !== true
    || proof.supersededReferencesAbsent !== true || proof.outputSha256 !== outputDigest
    || !Array.isArray(proof.targets) || proof.targets.length !== request.pages.length
    || !Array.isArray(proof.supersededReferences) || outputLength < 64 || sourceLength < 5) return false;
  const targetKeys = ['page', 'cropBox', 'cropBoxFilled', 'directEmptyResources', 'blackStreamObjectNumber'];
  const seenPages = new Set();
  for (const [index, target] of proof.targets.entries()) {
    const targetFields = target && typeof target === 'object' && !Array.isArray(target) ? Object.keys(target) : [];
    if (targetFields.length !== targetKeys.length || !targetFields.every((key, fieldIndex) => key === targetKeys[fieldIndex])
      || target.page !== request.pages[index] || seenPages.has(target.page) || !Array.isArray(target.cropBox) || target.cropBox.length !== 4
      || !target.cropBox.every((value) => Number.isFinite(value)) || target.cropBoxFilled !== true || target.directEmptyResources !== true
      || !Number.isSafeInteger(target.blackStreamObjectNumber) || target.blackStreamObjectNumber < 1) return false;
    seenPages.add(target.page);
  }
  const references = [...proof.supersededReferences];
  if (references.some((reference) => typeof reference !== 'string' || !/^\d+:[0-9]+$/.test(reference))
    || references.some((reference, index) => index > 0 && references[index - 1] >= reference)
    || new Set(references).size !== references.length) return false;
  return true;
}
async function cleanup(store, workspaces, promoted, completed) {
  const results = await Promise.allSettled(workspaces.reverse().map((workspace) => store.cleanupJob(workspace))); const workspaceFailed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!completed || workspaceFailed) && promoted?.artifact?.id) { try { await store.deleteArtifact(promoted.artifact.id); } catch { artifactFailed = true; } }
  if (workspaceFailed || artifactFailed) fail('FULL_PAGE_REDACTION_CLEANUP_FAILED', 'Full-page redaction could not clean its private workspace or artifact.', 500);
}
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }

export class PdfFullPageRedactionService {
  #store; #poppler; #core;
  constructor({ store, poppler, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfFullPageRedactionService requires a DocumentStore-compatible store.');
    if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('PdfFullPageRedactionService requires a Poppler adapter.');
    this.#store = store; this.#poppler = poppler; this.#core = checkedCore(core);
  }
  async update(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = checkedRequest(value); const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The full-page redaction source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_SOURCE_BYTES) fail('FULL_PAGE_REDACTION_INPUT_TOO_LARGE', 'Full-page redaction is limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(externalSignal, MAX_JOB_MS); const workspaces = []; let sourceBytes = null; let outputBytes = null; let writtenBytes = null; let promoted = null; let completed = false;
    try {
      abort(deadline.signal); await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId); workspaces.push(workspace); const signatureWorkspace = await this.#store.createJobWorkspace(documentId); workspaces.push(signatureWorkspace);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal });
      await workspaceSafe(workspace, BEFORE_FILES);
      const sourceSnapshot = await snapshot({ poppler: this.#poppler, input: inputPath, workspace, signatureWorkspace, signal: deadline.signal });
      if (request.page > sourceSnapshot.envelope.inspection.pageCount) fail('INVALID_FULL_PAGE_REDACTION_OPTIONS', 'The selected page is outside the source document.', 400);
      sourceBytes = await readPdf(inputPath, true); if (sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private full-page redaction source changed before parsing.', 500);
      const written = this.#core.writeFullPageRedaction(sourceBytes, request); writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(writtenBytes) || overlap(writtenBytes, sourceBytes) || !written?.proof) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The raw full-page redaction writer returned an invalid result.');
      const outputDigest = createHash('sha256').update(writtenBytes).digest('hex'); if (!proofValid(written.proof, sourceBytes.length, writtenBytes.length, request, outputDigest)) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The raw full-page redaction proof did not match the closed-output contract.');
      await writePrivateOutput(outputPath, writtenBytes); writtenBytes.fill(0); writtenBytes = null; const outputIdentity = await identity(outputPath); await workspaceSafe(workspace, AFTER_FILES);
      outputBytes = await readPdf(outputPath); if (createHash('sha256').update(outputBytes).digest('hex') !== outputDigest) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The staged full-page redaction output changed after the writer digest was recorded.'); const outputStructure = parsePdfStructure(outputBytes); if (outputStructure.revisions.length !== 1 || outputStructure.revisions[0].trailer.has('Prev')) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The full-page redaction output is not a closed compact rewrite.');
      const outputSnapshot = await snapshot({ poppler: this.#poppler, input: outputPath, workspace, signatureWorkspace, signal: deadline.signal });
      const nonTargetTextMatches = sourceSnapshot.content.textPages.every((entry, index) => index + 1 === request.page || entry.text === outputSnapshot.content.textPages[index]?.text);
      if (outputSnapshot.envelope.inspection.pageCount !== sourceSnapshot.envelope.inspection.pageCount || outputSnapshot.content.textPages[request.page - 1]?.text !== '' || !nonTargetTextMatches || outputSnapshot.signatures.status !== 'unsigned' || outputSnapshot.signatures.signatureCount !== 0 || !isDeepStrictEqual(sourceSnapshot.content.pageBoxes, outputSnapshot.content.pageBoxes)) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'Poppler observed an unexpected page count, target text, non-target text, page geometry, or signature change.');
      for (const field of ['attachments', 'urls']) if (outputSnapshot.envelope[field].length !== 0) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', `The closed output retained ${field}.`);
      await assertRenders({ poppler: this.#poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount, targetPage: request.page });
      await workspaceSafe(workspace, AFTER_FILES); await assertIdentity(outputPath, outputIdentity); await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES }); await this.#store.verifySource(documentId); abort(deadline.signal);
      const operation = createOperationProvenance({ type: 'pdf-full-page-redaction', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: request.profile, page: request.page }, expected: { pageCount: sourceSnapshot.envelope.inspection.pageCount, sourceUnchanged: true, closedCompactRewrite: true, fullPageOnly: true }, validation: { passed: true, validators: PDF_FULL_PAGE_REDACTION_VALIDATORS, pageCount: sourceSnapshot.envelope.inspection.pageCount, targetPage: request.page, outputSha256: outputDigest } });
      const stem = basename(source.displayName, extname(source.displayName)); const artifact = await this.#store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-full-page-redaction.pdf`, operation, expectedSha256: outputDigest, signal: deadline.signal });
      promoted = freeze({ kind: 'pdf-full-page-redaction', sourceDigest: source.sha256, artifact, redaction: { page: request.page, fullPage: true }, evidence: { sourceDigestReverified: true, closedCompactRewrite: true, targetContentResourcesRemoved: true, pageCountMatched: true, targetTextEmpty: true, targetRenderBlack: true, nonTargetTextRenderMatched: true, outputUnsigned: true, attachmentsAbsent: true, urlsAbsent: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }, limitations: PDF_FULL_PAGE_REDACTION_LIMITATIONS });
      if (promoted.artifact.sha256 !== outputDigest || promoted.artifact.id === source.id) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The promoted full-page redaction artifact does not match the validated output.');
      abort(deadline.signal); completed = true; return promoted;
    } catch (error) { throw mapFailure(error, externalSignal, deadline); } finally { deadline.dispose(); sourceBytes?.fill(0); outputBytes?.fill(0); writtenBytes?.fill(0); await cleanup(this.#store, workspaces, promoted, completed); }
  }
  async updateBatch(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = checkedBatchRequest(value); const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The full-page redaction source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_SOURCE_BYTES) fail('FULL_PAGE_REDACTION_INPUT_TOO_LARGE', 'Full-page redaction is limited to non-empty 128 MiB documents.', 413);
    if (typeof this.#core.writeFullPageRedactionBatch !== 'function') throw new TypeError('PdfFullPageRedactionService requires the batch redaction writer.');
    const deadline = createDeadline(externalSignal, MAX_JOB_MS); const workspaces = []; let sourceBytes = null; let outputBytes = null; let writtenBytes = null; let promoted = null; let completed = false;
    try {
      abort(deadline.signal); await this.#store.verifySource(documentId); const workspace = await this.#store.createJobWorkspace(documentId); workspaces.push(workspace); const signatureWorkspace = await this.#store.createJobWorkspace(documentId); workspaces.push(signatureWorkspace); const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal }); await workspaceSafe(workspace, BEFORE_FILES); const sourceSnapshot = await snapshot({ poppler: this.#poppler, input: inputPath, workspace, signatureWorkspace, signal: deadline.signal });
      if (request.pages.some((page) => page > sourceSnapshot.envelope.inspection.pageCount)) fail('INVALID_FULL_PAGE_REDACTION_BATCH_OPTIONS', 'A selected page is outside the source document.', 400);
      sourceBytes = await readPdf(inputPath, true); if (sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private full-page redaction source changed before parsing.', 500);
      const written = this.#core.writeFullPageRedactionBatch(sourceBytes, request); writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(writtenBytes) || overlap(writtenBytes, sourceBytes) || !written?.proof) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The batch redaction writer returned invalid output.');
      const outputDigest = createHash('sha256').update(writtenBytes).digest('hex');
      if (!batchProofValid(written.proof, sourceBytes.length, writtenBytes.length, request, outputDigest)) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The batch redaction writer returned invalid proof.');
      await writePrivateOutput(outputPath, writtenBytes); writtenBytes.fill(0); writtenBytes = null; const outputIdentity = await identity(outputPath); await workspaceSafe(workspace, AFTER_FILES); outputBytes = await readPdf(outputPath); if (createHash('sha256').update(outputBytes).digest('hex') !== outputDigest) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The staged batch redaction output changed after the writer digest was recorded.');
      const outputStructure = parsePdfStructure(outputBytes); if (outputStructure.revisions.length !== 1 || outputStructure.revisions[0].trailer.has('Prev')) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The batch redaction output is not a closed compact rewrite.');
      let outputSnapshot;
      try { outputSnapshot = await snapshot({ poppler: this.#poppler, input: outputPath, workspace, signatureWorkspace, signal: deadline.signal }); } catch (error) { if (error?.code === 'FULL_PAGE_REDACTION_SOURCE_UNSUPPORTED') fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The closed batch output retained unsupported metadata.'); throw error; }
      const targets = new Set(request.pages); const textMatches = sourceSnapshot.content.textPages.every((entry, index) => targets.has(index + 1) ? outputSnapshot.content.textPages[index]?.text === '' : entry.text === outputSnapshot.content.textPages[index]?.text); if (outputSnapshot.envelope.inspection.pageCount !== sourceSnapshot.envelope.inspection.pageCount || !textMatches || outputSnapshot.signatures.status !== 'unsigned' || outputSnapshot.signatures.signatureCount !== 0 || !isDeepStrictEqual(sourceSnapshot.content.pageBoxes, outputSnapshot.content.pageBoxes)) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'Poppler observed an unexpected batch page, text, page geometry, or signature change.');
      for (const field of ['attachments', 'urls']) if (outputSnapshot.envelope[field].length !== 0) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', `The closed batch output retained ${field}.`);
      await assertRenders({ poppler: this.#poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount, targetPage: targets }); await workspaceSafe(workspace, AFTER_FILES); await assertIdentity(outputPath, outputIdentity); await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES }); await this.#store.verifySource(documentId); abort(deadline.signal);
      const operation = createOperationProvenance({
        type: 'pdf-full-page-redaction-batch', inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: { profile: request.profile, pages: request.pages },
        expected: { pageCount: sourceSnapshot.envelope.inspection.pageCount, sourceUnchanged: true, closedCompactRewrite: true, fullPageOnly: true },
        validation: { passed: true, validators: PDF_FULL_PAGE_REDACTION_VALIDATORS, pageCount: sourceSnapshot.envelope.inspection.pageCount, targetPages: request.pages, outputSha256: outputDigest },
      });
      const stem = basename(source.displayName, extname(source.displayName));
      const artifact = await this.#store.promotePdfArtifact(documentId, outputPath, {
        displayName: `${stem}-full-page-redaction-batch.pdf`, operation,
        expectedSha256: outputDigest, signal: deadline.signal,
      });
      promoted = freeze({
        kind: 'pdf-full-page-redaction-batch', sourceDigest: source.sha256, artifact, pages: request.pages,
        evidence: { sourceDigestReverified: true, closedCompactRewrite: true, targetContentResourcesRemoved: true, pageCountMatched: true, targetTextEmpty: true, targetPagesBlack: true, nonTargetTextRenderMatched: true, outputUnsigned: true, attachmentsAbsent: true, urlsAbsent: true, artifactDigestBound: true, sourceUnchanged: true, fullPageOnly: true, localOnly: true },
        limitations: Object.freeze(['Only 1–32 unique sorted full-page targets in a bounded passive PDF are supported.', 'This operation does not claim whole-document sanitization, signature preservation, or label-based navigation.']),
      });
      if (promoted.artifact.sha256 !== outputDigest || promoted.artifact.id === source.id) fail('FULL_PAGE_REDACTION_OUTPUT_INVALID', 'The promoted batch redaction artifact does not match the validated output.');
      abort(deadline.signal); completed = true; return promoted;
    } catch (error) { throw mapFailure(error, externalSignal, deadline); } finally { deadline.dispose(); sourceBytes?.fill(0); outputBytes?.fill(0); writtenBytes?.fill(0); await cleanup(this.#store, workspaces, promoted, completed); }
  }
}
export function createPdfFullPageRedactionService(options) { return new PdfFullPageRedactionService(options); }
