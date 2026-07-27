import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promoteIncrementalGoToLinkArtifact } from './pdf-incremental-goto-link-artifact.mjs';
import { GOTO_LINK_AFTER_FILES, GOTO_LINK_BEFORE_FILES, MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES, assertGoToLinkWorkspace, assertIncrementalGoToLinkFileIdentity, assertIncrementalGoToLinkProof, assertIncrementalGoToLinkRendersMatch, incrementalGoToLinkContentMatches, incrementalGoToLinkEnvelopeMatches, incrementalGoToLinkEnvelopeSupported, incrementalGoToLinkFileIdentity, inspectIncrementalGoToLinkContent, inspectIncrementalGoToLinkEnvelope, readStableIncrementalGoToLink, writePrivateIncrementalGoToLinkOutput } from './pdf-incremental-goto-link-validation.mjs';

function fail(code, message, status = 502) { throw new HostError(code, message, status); }
function aborted(signal) { if (signal.aborted) throw signal.reason ?? new Error('Incremental GoTo-link processing was cancelled.'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }
async function snapshot(poppler, input, workspace, signatureWorkspace, signal) {
  const [envelope, signatures] = await Promise.all([inspectIncrementalGoToLinkEnvelope(poppler, input, workspace, signal), executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal })]);
  if (!incrementalGoToLinkEnvelopeSupported(envelope, signatures)) fail('INCREMENTAL_GOTO_LINK_SOURCE_UNSUPPORTED', 'Incremental GoTo links require an unsigned, unencrypted PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
  return Object.freeze({ envelope, signatures, content: await inspectIncrementalGoToLinkContent(poppler, input, workspace, signal, envelope.inspection.pageCount) });
}
export async function runIncrementalGoToLinkJob({ store, poppler, core, documentId, source, request, deadline, lifecycle }) {
  aborted(deadline.signal); await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
  const signatureWorkspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(signatureWorkspace);
  const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
  const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES });
  await assertGoToLinkWorkspace(workspace, GOTO_LINK_BEFORE_FILES);
  const sourceSnapshot = await snapshot(poppler, inputPath, workspace, signatureWorkspace, deadline.signal);
  if (request.sourcePage > sourceSnapshot.envelope.inspection.pageCount || request.targetPage > sourceSnapshot.envelope.inspection.pageCount) fail('INVALID_INCREMENTAL_GOTO_LINK_OPTIONS', 'The selected GoTo-link page is outside the source document.', 400);
  lifecycle.sourceBytes = await readStableIncrementalGoToLink(inputPath, MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES);
  if (lifecycle.sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private incremental GoTo-link source changed before parsing.', 500);
  let written = core.writeIncrementalPdfGoToLink(lifecycle.sourceBytes, request); let writtenProof;
  try {
    if (!written?.proof || !Buffer.isBuffer(written.bytes) || overlap(written.bytes, lifecycle.sourceBytes)) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The raw incremental GoTo-link writer returned an invalid result.');
    assertIncrementalGoToLinkProof(written.proof, lifecycle.sourceBytes.length, written.bytes.length, request);
    writtenProof = written.proof;
    if (!written.bytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The raw GoTo-link writer changed the source prefix.');
    await writePrivateIncrementalGoToLinkOutput(outputPath, written.bytes);
  } finally { if (Buffer.isBuffer(written?.bytes) && !overlap(written.bytes, lifecycle.sourceBytes)) written.bytes.fill(0); written = null; }
  await assertGoToLinkWorkspace(workspace, GOTO_LINK_AFTER_FILES);
  lifecycle.outputBytes = await readStableIncrementalGoToLink(outputPath);
  const outputIdentity = await incrementalGoToLinkFileIdentity(outputPath);
  const proof = core.inspectIncrementalPdfGoToLink(lifecycle.sourceBytes, lifecycle.outputBytes, request);
  assertIncrementalGoToLinkProof(proof, lifecycle.sourceBytes.length, lifecycle.outputBytes.length, request);
  if (!isDeepStrictEqual(writtenProof, proof)) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the incremental GoTo-link writer proof.');
  const outputSnapshot = await snapshot(poppler, outputPath, workspace, signatureWorkspace, deadline.signal);
  if (!incrementalGoToLinkEnvelopeMatches(sourceSnapshot.envelope, outputSnapshot.envelope)
    || outputSnapshot.signatures.status !== 'unsigned'
    || outputSnapshot.signatures.signatureCount !== 0
    || !incrementalGoToLinkContentMatches(sourceSnapshot.content, outputSnapshot.content)) {
    fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'Poppler observed an unexpected GoTo-link document change.');
  }
  await assertIncrementalGoToLinkRendersMatch({ poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount });
  await assertGoToLinkWorkspace(workspace, GOTO_LINK_AFTER_FILES);
  await assertIncrementalGoToLinkFileIdentity(outputPath, outputIdentity);
  await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES }); await store.verifySource(documentId); aborted(deadline.signal);
  const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex');
  if (outputDigest === source.sha256) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The incremental GoTo-link output did not produce a distinct artifact digest.');
  lifecycle.promotedArtifact = await promoteIncrementalGoToLinkArtifact({ store, documentId, source, outputPath, outputDigest, pageCount: sourceSnapshot.envelope.inspection.pageCount, request, signal: deadline.signal });
  if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest || lifecycle.promotedArtifact.artifact.id === source.id) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The promoted GoTo-link artifact does not match the validated output.');
  aborted(deadline.signal); lifecycle.completed = true; return lifecycle.promotedArtifact;
}
