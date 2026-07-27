import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promotePdfJavaScriptRemovalArtifact } from './pdf-javascript-removal-artifact.mjs';
import { MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES, PDF_JAVASCRIPT_REMOVAL_AFTER_FILES, PDF_JAVASCRIPT_REMOVAL_BEFORE_FILES, assertPdfJavaScriptRemovalFileIdentity, assertPdfJavaScriptRemovalProof, assertPdfJavaScriptRemovalRendersMatch, assertPdfJavaScriptRemovalWorkspace, inspectPdfJavaScriptRemovalContent, inspectPdfJavaScriptRemovalEnvelope, pdfJavaScriptRemovalContentMatches, pdfJavaScriptRemovalEnvelopeMatches, pdfJavaScriptRemovalFileIdentity, pdfJavaScriptRemovalSourceSupported, readStablePdfJavaScriptRemoval, writePrivatePdfJavaScriptRemovalOutput } from './pdf-javascript-removal-validation.mjs';
function fail(code, message, status = 502) { throw new HostError(code, message, status); }
function aborted(signal) { if (signal.aborted) throw signal.reason ?? new Error('JavaScript-removal processing was cancelled.'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }
async function snapshot(poppler, input, workspace, signatureWorkspace, signal, { source = false } = {}) {
  const [envelope, signatures] = await Promise.all([inspectPdfJavaScriptRemovalEnvelope(poppler, input, workspace, signal), executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal })]);
  if (source && !pdfJavaScriptRemovalSourceSupported(envelope, signatures)) fail('PDF_JAVASCRIPT_REMOVAL_SOURCE_UNSUPPORTED', 'JavaScript removal requires an unsigned, unencrypted, form-free PDF with document JavaScript and no XMP, attachments, or URLs.', 422);
  return Object.freeze({ envelope, signatures, content: await inspectPdfJavaScriptRemovalContent(poppler, input, workspace, signal, envelope.inspection.pageCount) });
}
export async function runPdfJavaScriptRemovalJob({ store, poppler, core, documentId, source, request, deadline, lifecycle }) {
  aborted(deadline.signal); await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
  const signatureWorkspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(signatureWorkspace);
  const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
  const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES });
  await assertPdfJavaScriptRemovalWorkspace(workspace, PDF_JAVASCRIPT_REMOVAL_BEFORE_FILES);
  const sourceSnapshot = await snapshot(poppler, inputPath, workspace, signatureWorkspace, deadline.signal, { source: true });
  lifecycle.sourceBytes = await readStablePdfJavaScriptRemoval(inputPath, MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES);
  if (lifecycle.sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private JavaScript-removal source changed before parsing.', 500);
  let written; let writtenProof;
  try { written = core.writePdfJavaScriptRemoval(lifecycle.sourceBytes, request); if (!written?.proof || !Buffer.isBuffer(written.bytes) || overlap(written.bytes, lifecycle.sourceBytes)) fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'The raw JavaScript-removal writer returned an invalid result.'); assertPdfJavaScriptRemovalProof(written.proof, lifecycle.sourceBytes, written.bytes, request); writtenProof = written.proof; await writePrivatePdfJavaScriptRemovalOutput(outputPath, written.bytes); } finally { if (Buffer.isBuffer(written?.bytes) && !overlap(written.bytes, lifecycle.sourceBytes)) written.bytes.fill(0); }
  await assertPdfJavaScriptRemovalWorkspace(workspace, PDF_JAVASCRIPT_REMOVAL_AFTER_FILES); lifecycle.outputBytes = await readStablePdfJavaScriptRemoval(outputPath); const outputIdentity = await pdfJavaScriptRemovalFileIdentity(outputPath);
  const proof = core.inspectPdfJavaScriptRemoval(lifecycle.sourceBytes, lifecycle.outputBytes, request); assertPdfJavaScriptRemovalProof(proof, lifecycle.sourceBytes, lifecycle.outputBytes, request);
  if (!isDeepStrictEqual(writtenProof, proof)) fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the JavaScript-removal writer proof.');
  const outputSnapshot = await snapshot(poppler, outputPath, workspace, signatureWorkspace, deadline.signal);
  if (!pdfJavaScriptRemovalEnvelopeMatches(sourceSnapshot.envelope, outputSnapshot.envelope) || outputSnapshot.signatures.status !== 'unsigned' || outputSnapshot.signatures.signatureCount !== 0 || !pdfJavaScriptRemovalContentMatches(sourceSnapshot.content, outputSnapshot.content)) fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'Poppler observed an unexpected JavaScript-removal document change.');
  await assertPdfJavaScriptRemovalRendersMatch({ poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount }); await assertPdfJavaScriptRemovalWorkspace(workspace, PDF_JAVASCRIPT_REMOVAL_AFTER_FILES); await assertPdfJavaScriptRemovalFileIdentity(outputPath, outputIdentity); await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES }); await store.verifySource(documentId); aborted(deadline.signal);
  const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex'); if (outputDigest === source.sha256) fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'JavaScript removal did not produce a distinct artifact digest.'); lifecycle.promotedArtifact = await promotePdfJavaScriptRemovalArtifact({ store, documentId, source, outputPath, outputDigest, pageCount: sourceSnapshot.envelope.inspection.pageCount, request, proof, signal: deadline.signal }); if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest || lifecycle.promotedArtifact.artifact.id === source.id) fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'The promoted JavaScript-removal artifact does not match validated output.'); aborted(deadline.signal); lifecycle.completed = true; return lifecycle.promotedArtifact;
}
