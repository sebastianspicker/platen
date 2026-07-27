import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promotePdfAnnotationFlattenArtifact } from './pdf-annotation-flatten-artifact.mjs';
import {
  MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES, PDF_ANNOTATION_FLATTEN_AFTER_FILES,
  PDF_ANNOTATION_FLATTEN_BEFORE_FILES, assertPdfAnnotationFlattenFileIdentity,
  assertPdfAnnotationFlattenProof, assertPdfAnnotationFlattenRendersMatch,
  assertPdfAnnotationFlattenWorkspace, inspectPdfAnnotationFlattenContent,
  inspectPdfAnnotationFlattenEnvelope, pdfAnnotationFlattenContentMatches,
  pdfAnnotationFlattenEnvelopeMatches, pdfAnnotationFlattenFileIdentity,
  pdfAnnotationFlattenSourceSupported, readStablePdfAnnotationFlatten,
  writePrivatePdfAnnotationFlattenOutput,
} from './pdf-annotation-flatten-validation.mjs';

function fail(code, message, status = 502) { throw new HostError(code, message, status); }
function aborted(signal) { if (signal.aborted) throw signal.reason ?? new Error('Annotation flatten processing was cancelled.'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }

async function snapshot(poppler, input, workspace, signatureWorkspace, signal, { source = false } = {}) {
  const [envelope, signatures] = await Promise.all([
    inspectPdfAnnotationFlattenEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal }),
  ]);
  if (source && !pdfAnnotationFlattenSourceSupported(envelope, signatures)) {
    fail('PDF_ANNOTATION_FLATTEN_SOURCE_UNSUPPORTED', 'Annotation flatten requires an unsigned, unencrypted, untagged PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
  }
  return Object.freeze({ envelope, signatures, content: await inspectPdfAnnotationFlattenContent(poppler, input, workspace, signal, envelope.inspection.pageCount) });
}

export async function runPdfAnnotationFlattenJob({ store, poppler, core, documentId, source, request, deadline, lifecycle }) {
  aborted(deadline.signal);
  await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
  const signatureWorkspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(signatureWorkspace);
  const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
  const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES, signal: deadline.signal });
  await assertPdfAnnotationFlattenWorkspace(workspace, PDF_ANNOTATION_FLATTEN_BEFORE_FILES);
  const sourceSnapshot = await snapshot(poppler, inputPath, workspace, signatureWorkspace, deadline.signal, { source: true });
  if (request.target.page > sourceSnapshot.envelope.inspection.pageCount) fail('INVALID_PDF_ANNOTATION_FLATTEN_OPTIONS', 'The selected annotation page is outside the source document.', 400);
  lifecycle.sourceBytes = await readStablePdfAnnotationFlatten(inputPath, MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES);
  if (lifecycle.sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private annotation-flatten source changed before parsing.', 500);
  let written; let writtenProof;
  try {
    written = core.writePdfAnnotationFlatten(lifecycle.sourceBytes, request);
    if (!written?.proof || !Buffer.isBuffer(written.bytes) || overlap(written.bytes, lifecycle.sourceBytes)) fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'The raw annotation-flatten writer returned an invalid result.');
    assertPdfAnnotationFlattenProof(written.proof, lifecycle.sourceBytes, written.bytes, request);
    writtenProof = written.proof;
    await writePrivatePdfAnnotationFlattenOutput(outputPath, written.bytes);
  } finally {
    if (Buffer.isBuffer(written?.bytes) && !overlap(written.bytes, lifecycle.sourceBytes)) written.bytes.fill(0);
  }
  await assertPdfAnnotationFlattenWorkspace(workspace, PDF_ANNOTATION_FLATTEN_AFTER_FILES);
  lifecycle.outputBytes = await readStablePdfAnnotationFlatten(outputPath);
  const outputIdentity = await pdfAnnotationFlattenFileIdentity(outputPath);
  const proof = core.inspectPdfAnnotationFlatten(lifecycle.sourceBytes, lifecycle.outputBytes, request);
  assertPdfAnnotationFlattenProof(proof, lifecycle.sourceBytes, lifecycle.outputBytes, request);
  if (!isDeepStrictEqual(writtenProof, proof)) fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the annotation-flatten writer proof.');
  const outputSnapshot = await snapshot(poppler, outputPath, workspace, signatureWorkspace, deadline.signal);
  if (!pdfAnnotationFlattenEnvelopeMatches(sourceSnapshot.envelope, outputSnapshot.envelope)
    || outputSnapshot.signatures.status !== 'unsigned' || outputSnapshot.signatures.signatureCount !== 0
    || !pdfAnnotationFlattenContentMatches(sourceSnapshot.content, outputSnapshot.content)) {
    fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'Poppler observed an unexpected annotation-flatten document change.');
  }
  await assertPdfAnnotationFlattenRendersMatch({ poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount });
  await assertPdfAnnotationFlattenWorkspace(workspace, PDF_ANNOTATION_FLATTEN_AFTER_FILES);
  await assertPdfAnnotationFlattenFileIdentity(outputPath, outputIdentity);
  await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES });
  await store.verifySource(documentId);
  aborted(deadline.signal);
  const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex');
  if (outputDigest === source.sha256) fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'Annotation flatten did not produce a distinct artifact digest.');
  lifecycle.promotedArtifact = await promotePdfAnnotationFlattenArtifact({ store, documentId, source, outputPath, outputDigest, pageCount: sourceSnapshot.envelope.inspection.pageCount, request, signal: deadline.signal });
  if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest || lifecycle.promotedArtifact.artifact.id === source.id) fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'The promoted annotation-flatten artifact does not match validated output.');
  aborted(deadline.signal);
  lifecycle.completed = true;
  return lifecycle.promotedArtifact;
}
