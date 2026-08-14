import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createDeadline, executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { normalizeIncrementalAccessibilityMetadata } from './pdf-incremental-accessibility-metadata-contract.mjs';
import { inspectIncrementalPdfAccessibilityMetadata, writeIncrementalPdfAccessibilityMetadata } from './pdf-incremental-accessibility-metadata-writer.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promoteIncrementalAccessibilityMetadataArtifact } from './pdf-incremental-accessibility-metadata-artifact.mjs';
import {
  ACCESSIBILITY_AFTER_FILES, ACCESSIBILITY_BEFORE_FILES, MAX_INCREMENTAL_ACCESSIBILITY_SOURCE_BYTES,
  accessibilityContentMatches, accessibilityEnvelopeSupported, accessibilityFileIdentity,
  accessibilityOutputMatches, assertAccessibilityFileIdentity, assertAccessibilityPassiveSource,
  assertAccessibilityProof, assertAccessibilityRendersMatch, assertAccessibilityWorkspace,
  inspectAccessibilityContent, inspectAccessibilityEnvelope, readStableAccessibilityOutput,
  readStableAccessibilitySource, writePrivateAccessibilityOutput,
} from './pdf-incremental-accessibility-metadata-validation.mjs';

const MAX_JOB_MS = 2 * 60_000; const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_CORE = Object.freeze({ normalizeIncrementalAccessibilityMetadata, writeIncrementalPdfAccessibilityMetadata, inspectIncrementalPdfAccessibilityMetadata });
function fail(code, message, status = 502) { throw new HostError(code, message, status); }
function cancelled(signal) { if (signal.aborted) throw signal.reason ?? new Error('Incremental accessibility metadata processing was cancelled.'); }
function checkedCore(core) { const names = Object.keys(DEFAULT_CORE); if (!core || names.some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfIncrementalAccessibilityMetadataService requires the fixed raw accessibility metadata core API.'); return core; }
function checkedRequest(core, value) { try { return core.normalizeIncrementalAccessibilityMetadata(value); } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA') fail('INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OPTIONS', 'The document language and title are invalid.', 400); throw error; } }
async function snapshot(poppler, input, workspace, signatures, signal) {
  const [envelope, signature] = await Promise.all([inspectAccessibilityEnvelope(poppler, input, workspace, signal), executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatures, signal })]);
  if (!accessibilityEnvelopeSupported(envelope, signature) || String(envelope.inspection.tagged).toLowerCase() !== 'no') fail('INCREMENTAL_ACCESSIBILITY_METADATA_SOURCE_UNSUPPORTED', 'Accessibility metadata editing requires an unsigned, unprotected passive PDF without forms, JavaScript, XMP, attachments, URLs, tags, or layers.', 422);
  return Object.freeze({ envelope, content: await inspectAccessibilityContent(poppler, input, workspace, signal, envelope.inspection.pageCount) });
}
function mapped(error, external, deadline) {
  if (deadline.timedOut) return new HostError('INCREMENTAL_ACCESSIBILITY_METADATA_TIMEOUT', 'Incremental accessibility metadata processing exceeded its two-minute deadline.', 504, { cause: error });
  if (external?.aborted) return new HostError('JOB_CANCELLED', 'Incremental accessibility metadata processing was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'UNSUPPORTED_INCREMENTAL_ACCESSIBILITY_METADATA_PDF') return new HostError('INCREMENTAL_ACCESSIBILITY_METADATA_SOURCE_UNSUPPORTED', 'The PDF is outside the supported passive accessibility metadata subset.', 422, { cause: error });
  if (error?.code === 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT') return new HostError('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'The append-only accessibility metadata output failed separate raw reinspection.', 502, { cause: error });
  return new HostError('INCREMENTAL_ACCESSIBILITY_METADATA_FAILED', 'The local host could not create a verified append-only accessibility metadata copy.', 502, { cause: error });
}
async function cleanup(store, workspaces, promoted, complete) { const cleaned = await Promise.allSettled(workspaces.map((path) => store.cleanupJob(path))); const workspaceFailed = cleaned.some(({ status }) => status === 'rejected'); let artifactFailed = false; if ((!complete || workspaceFailed) && promoted?.artifact?.id) { try { await store.deleteArtifact(promoted.artifact.id); } catch { artifactFailed = true; } } if (workspaceFailed || artifactFailed) fail('INCREMENTAL_ACCESSIBILITY_METADATA_CLEANUP_FAILED', 'Incremental accessibility metadata processing could not clean its private workspace or artifact.', 500); }

export class PdfIncrementalAccessibilityMetadataService {
  #store; #poppler; #core;
  constructor({ store, poppler, core = DEFAULT_CORE } = {}) { const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']; if (!store || methods.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfIncrementalAccessibilityMetadataService requires a DocumentStore-compatible store.'); if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('PdfIncrementalAccessibilityMetadataService requires a Poppler adapter.'); this.#store = store; this.#poppler = poppler; this.#core = checkedCore(core); }
  async update(documentId, requestValue, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = checkedRequest(this.#core, requestValue); const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_INCREMENTAL_ACCESSIBILITY_SOURCE_BYTES) fail('INCREMENTAL_ACCESSIBILITY_METADATA_INPUT_TOO_LARGE', 'Accessibility metadata editing is limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(externalSignal, MAX_JOB_MS); const workspaces = []; let sourceBytes; let outputBytes; let writtenBytes; let promoted; let complete = false;
    try {
      cancelled(deadline.signal); await this.#store.verifySource(documentId); const workspace = await this.#store.createJobWorkspace(documentId); const signatures = await this.#store.createJobWorkspace(documentId); workspaces.push(workspace, signatures); const input = join(workspace, 'input.pdf'); const output = join(workspace, 'output.pdf');
      const identity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: input, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_ACCESSIBILITY_SOURCE_BYTES, signal: deadline.signal }); await assertAccessibilityWorkspace(workspace, ACCESSIBILITY_BEFORE_FILES);
      sourceBytes = await readStableAccessibilitySource(input, source.size); assertAccessibilityPassiveSource(sourceBytes); const before = await snapshot(this.#poppler, input, workspace, signatures, deadline.signal); cancelled(deadline.signal);
      const written = this.#core.writeIncrementalPdfAccessibilityMetadata(sourceBytes, request); writtenBytes = written?.bytes; if (!Buffer.isBuffer(writtenBytes) || !written?.proof) fail('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'The raw accessibility writer returned an invalid result.'); assertAccessibilityProof(written.proof, sourceBytes.length, writtenBytes.length); if (!writtenBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'The raw accessibility writer changed the source prefix.');
      await writePrivateAccessibilityOutput(output, writtenBytes); writtenBytes.fill(0); writtenBytes = null; const outputIdentity = await accessibilityFileIdentity(output); await assertAccessibilityWorkspace(workspace, ACCESSIBILITY_AFTER_FILES); outputBytes = await readStableAccessibilityOutput(output);
      const rawProof = this.#core.inspectIncrementalPdfAccessibilityMetadata(sourceBytes, outputBytes, request); assertAccessibilityProof(rawProof, sourceBytes.length, outputBytes.length); if (!isDeepStrictEqual(written.proof, rawProof) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'Separate raw inspection disagreed with the writer proof or source prefix.');
      const after = await snapshot(this.#poppler, output, workspace, signatures, deadline.signal); if (!accessibilityOutputMatches(before.envelope, after.envelope, request) || !accessibilityContentMatches(before.content, after.content)) fail('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'Accessibility metadata output changed non-target document evidence.'); await assertAccessibilityRendersMatch({ poppler: this.#poppler, sourcePath: input, outputPath: output, workspace, signal: deadline.signal, pageCount: before.envelope.inspection.pageCount }); await assertAccessibilityFileIdentity(output, outputIdentity); await assertPrivateSourceCopy({ path: input, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_ACCESSIBILITY_SOURCE_BYTES }); await this.#store.verifySource(documentId); cancelled(deadline.signal);
      const digest = createHash('sha256').update(outputBytes).digest('hex'); if (digest === source.sha256) fail('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'The output digest is not distinct.'); promoted = await promoteIncrementalAccessibilityMetadataArtifact({ store: this.#store, documentId, source, outputPath: output, outputDigest: digest, pageCount: before.envelope.inspection.pageCount, request, signal: deadline.signal }); if (promoted.artifact.sha256 !== digest || promoted.artifact.id === source.id) fail('INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT_INVALID', 'The promoted artifact is not bound to the validated output.'); complete = true; return promoted;
    } catch (error) { throw mapped(error, externalSignal, deadline); } finally { deadline.dispose(); sourceBytes?.fill(0); outputBytes?.fill(0); writtenBytes?.fill(0); await cleanup(this.#store, workspaces.reverse(), promoted, complete); }
  }
}
