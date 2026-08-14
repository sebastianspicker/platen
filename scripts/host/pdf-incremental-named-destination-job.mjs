import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promoteIncrementalNamedDestinationArtifact } from './pdf-incremental-named-destination-artifact.mjs';
import {
  NAMED_DESTINATION_AFTER_FILES, NAMED_DESTINATION_BEFORE_FILES,
  MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES,
  assertIncrementalNamedDestinationFileIdentity, assertIncrementalNamedDestinationProof,
  assertIncrementalNamedDestinationRendersMatch, assertNamedDestinationWorkspace,
  assertOutputNamedDestinationInventory, assertSourceNamedDestinationInventory,
  incrementalNamedDestinationContentMatches, incrementalNamedDestinationEnvelopeMatches,
  incrementalNamedDestinationEnvelopeSupported, incrementalNamedDestinationFileIdentity,
  inspectIncrementalNamedDestinationContent, inspectIncrementalNamedDestinationEnvelope,
  inspectNamedDestinationInventory, readStableIncrementalNamedDestination,
  writePrivateIncrementalNamedDestinationOutput,
} from './pdf-incremental-named-destination-validation.mjs';

function fail(code, message, status = 502) { throw new HostError(code, message, status); }
function aborted(signal) { if (signal.aborted) throw signal.reason ?? new Error('Incremental named-destination processing was cancelled.'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }

async function snapshot(poppler, input, workspace, signatureWorkspace, signal) {
  const [envelope, signatures] = await Promise.all([
    inspectIncrementalNamedDestinationEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal }),
  ]);
  if (!incrementalNamedDestinationEnvelopeSupported(envelope, signatures)) {
    fail('INCREMENTAL_NAMED_DESTINATION_SOURCE_UNSUPPORTED', 'Incremental named destinations require an unsigned, unencrypted passive PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
  }
  const content = await inspectIncrementalNamedDestinationContent(poppler, input, workspace, signal, envelope.inspection.pageCount);
  const destinations = await inspectNamedDestinationInventory(poppler, input, workspace, signal, envelope.inspection.pageCount);
  return Object.freeze({ envelope, signatures, content, destinations });
}

export async function runIncrementalNamedDestinationJob({ store, poppler, core, documentId, source, request, deadline, lifecycle }) {
  aborted(deadline.signal);
  await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId);
  lifecycle.workspaces.push(workspace);
  const signatureWorkspace = await store.createJobWorkspace(documentId);
  lifecycle.workspaces.push(signatureWorkspace);
  const inputPath = join(workspace, 'input.pdf');
  const outputPath = join(workspace, 'output.pdf');
  const inputIdentity = await stagePrivateSourceCopy({
    sourcePath: store.getSourcePath(documentId), targetPath: inputPath,
    expectedSha256: source.sha256, expectedSize: source.size,
    maximumBytes: MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES,
  });
  await assertNamedDestinationWorkspace(workspace, NAMED_DESTINATION_BEFORE_FILES);
  const sourceSnapshot = await snapshot(poppler, inputPath, workspace, signatureWorkspace, deadline.signal);
  assertSourceNamedDestinationInventory(sourceSnapshot.destinations);
  if (request.targetPage > sourceSnapshot.envelope.inspection.pageCount) {
    fail('INVALID_INCREMENTAL_NAMED_DESTINATION_OPTIONS', 'The selected named-destination page is outside the source document.', 400);
  }
  lifecycle.sourceBytes = await readStableIncrementalNamedDestination(inputPath, MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES);
  if (lifecycle.sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private incremental named-destination source changed before parsing.', 500);
  let written = core.writeIncrementalPdfNamedDestination(lifecycle.sourceBytes, request);
  let writtenProof;
  try {
    if (!written?.proof || !Buffer.isBuffer(written.bytes) || overlap(written.bytes, lifecycle.sourceBytes)) {
      fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'The raw incremental named-destination writer returned an invalid result.');
    }
    assertIncrementalNamedDestinationProof(written.proof, lifecycle.sourceBytes.length, written.bytes.length, request);
    writtenProof = written.proof;
    if (!written.bytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) {
      fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'The raw named-destination writer changed the source prefix.');
    }
    await writePrivateIncrementalNamedDestinationOutput(outputPath, written.bytes);
  } finally {
    if (Buffer.isBuffer(written?.bytes) && !overlap(written.bytes, lifecycle.sourceBytes)) written.bytes.fill(0);
    written = null;
  }
  await assertNamedDestinationWorkspace(workspace, NAMED_DESTINATION_AFTER_FILES);
  lifecycle.outputBytes = await readStableIncrementalNamedDestination(outputPath);
  const outputIdentity = await incrementalNamedDestinationFileIdentity(outputPath);
  const proof = core.inspectIncrementalPdfNamedDestination(lifecycle.sourceBytes, lifecycle.outputBytes, request);
  assertIncrementalNamedDestinationProof(proof, lifecycle.sourceBytes.length, lifecycle.outputBytes.length, request);
  if (!isDeepStrictEqual(writtenProof, proof)) fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the incremental named-destination writer proof.');
  const outputSnapshot = await snapshot(poppler, outputPath, workspace, signatureWorkspace, deadline.signal);
  assertOutputNamedDestinationInventory(outputSnapshot.destinations, request);
  if (!incrementalNamedDestinationEnvelopeMatches(sourceSnapshot.envelope, outputSnapshot.envelope)
    || outputSnapshot.signatures.status !== 'unsigned' || outputSnapshot.signatures.signatureCount !== 0
    || !incrementalNamedDestinationContentMatches(sourceSnapshot.content, outputSnapshot.content)) {
    fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'Poppler observed an unexpected named-destination document change.');
  }
  await assertIncrementalNamedDestinationRendersMatch({ poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount });
  await assertNamedDestinationWorkspace(workspace, NAMED_DESTINATION_AFTER_FILES);
  await assertIncrementalNamedDestinationFileIdentity(outputPath, outputIdentity);
  await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES });
  await store.verifySource(documentId);
  aborted(deadline.signal);
  const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex');
  if (outputDigest === source.sha256) fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'The incremental named-destination output did not produce a distinct artifact digest.');
  lifecycle.promotedArtifact = await promoteIncrementalNamedDestinationArtifact({ store, documentId, source, outputPath, outputDigest, pageCount: sourceSnapshot.envelope.inspection.pageCount, request, signal: deadline.signal });
  if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest || lifecycle.promotedArtifact.artifact.id === source.id) fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'The promoted named-destination artifact does not match the validated output.');
  aborted(deadline.signal);
  lifecycle.completed = true;
  return lifecycle.promotedArtifact;
}
