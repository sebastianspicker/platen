import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promoteIncrementalBleedBoxArtifact } from './pdf-incremental-bleed-box-artifact.mjs';
import {
  INCREMENTAL_BLEED_BOX_AFTER_FILES,
  INCREMENTAL_BLEED_BOX_BEFORE_FILES,
  MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES,
  assertIncrementalBleedBoxFileIdentity,
  assertIncrementalBleedBoxProof,
  assertIncrementalBleedBoxRendersMatch,
  assertIncrementalBleedBoxWorkspace,
  incrementalBleedBoxContentMatches,
  incrementalBleedBoxEnvelopeMatches,
  incrementalBleedBoxEnvelopeSupported,
  incrementalBleedBoxFileIdentity,
  inspectIncrementalBleedBoxContent,
  inspectIncrementalBleedBoxEnvelope,
  readStableIncrementalBleedBox,
  writePrivateIncrementalBleedBoxOutput,
} from './pdf-incremental-bleed-box-validation.mjs';

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw signal.reason ?? new Error('Incremental bleed-box processing was cancelled.');
  }
}

async function inspectSupportedSnapshot({
  poppler,
  input,
  workspace,
  signatureWorkspace,
  signal,
}) {
  const settled = await Promise.allSettled([
    inspectIncrementalBleedBoxEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, {
      input,
      nssDirectory: signatureWorkspace,
      signal,
    }),
  ]);
  const rejected = settled.find(({ status }) => status === 'rejected');
  if (rejected) {
    if (rejected.reason?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING') {
      fail(
        'INCREMENTAL_BLEED_BOX_POPPLER_WARNING',
        'Poppler reported a warning while validating the incremental bleed-box PDF.',
        422,
      );
    }
    throw rejected.reason;
  }

  const [envelope, signatures] = settled.map(({ value }) => value);
  if (!incrementalBleedBoxEnvelopeSupported(envelope, signatures)) {
    fail(
      'INCREMENTAL_BLEED_BOX_SOURCE_UNSUPPORTED',
      'Incremental BleedBox editing requires an unsigned, unencrypted PDF without forms, JavaScript, XMP, attachments, or URLs.',
      422,
    );
  }

  try {
    const content = await inspectIncrementalBleedBoxContent(
      poppler,
      input,
      workspace,
      signal,
      envelope.inspection.pageCount,
    );
    return Object.freeze({ envelope, signatures, content });
  } catch (error) {
    if (error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING') {
      fail(
        'INCREMENTAL_BLEED_BOX_POPPLER_WARNING',
        'Poppler reported a warning while validating the incremental bleed-box PDF.',
        422,
      );
    }
    throw error;
  }
}

async function createPrivateJob(store, documentId, source, signal, lifecycle) {
  throwIfAborted(signal);
  await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId);
  lifecycle.workspaces.push(workspace);
  const signatureWorkspace = await store.createJobWorkspace(documentId);
  lifecycle.workspaces.push(signatureWorkspace);
  const inputPath = join(workspace, 'input.pdf');
  const outputPath = join(workspace, 'output.pdf');
  const inputIdentity = await stagePrivateSourceCopy({
    sourcePath: store.getSourcePath(documentId),
    targetPath: inputPath,
    expectedSha256: source.sha256,
    expectedSize: source.size,
    maximumBytes: MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES,
  });
  await assertIncrementalBleedBoxWorkspace(workspace, INCREMENTAL_BLEED_BOX_BEFORE_FILES);
  return Object.freeze({
    workspace,
    signatureWorkspace,
    inputPath,
    outputPath,
    inputIdentity,
  });
}

async function inspectSource({ poppler, job, signal, request }) {
  const snapshot = await inspectSupportedSnapshot({
    poppler,
    input: job.inputPath,
    workspace: job.workspace,
    signatureWorkspace: job.signatureWorkspace,
    signal,
  });
  if (request.page > snapshot.envelope.inspection.pageCount) {
    fail(
      'INVALID_INCREMENTAL_BLEED_BOX_OPTIONS',
      'The selected BleedBox page is outside the source document.',
      400,
    );
  }
  return snapshot;
}

function buffersOverlap(left, right) {
  if (left.buffer !== right.buffer) return false;
  const leftEnd = left.byteOffset + left.byteLength;
  const rightEnd = right.byteOffset + right.byteLength;
  return left.byteOffset < rightEnd && right.byteOffset < leftEnd;
}

async function writeCandidate({ core, sourceBytes, request, outputPath }) {
  const written = await core.writeIncrementalPdfBleedBox(sourceBytes, request);
  let writtenBytes = written?.bytes;
  try {
    if (!Buffer.isBuffer(writtenBytes) || buffersOverlap(writtenBytes, sourceBytes)
      || !written?.proof) {
      fail(
        'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
        'The raw incremental BleedBox writer returned an invalid result.',
      );
    }
    assertIncrementalBleedBoxProof(
      written.proof,
      sourceBytes.length,
      writtenBytes.length,
      request,
    );
    if (!writtenBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
      fail(
        'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
        'The raw incremental BleedBox writer changed the source prefix.',
      );
    }
    await writePrivateIncrementalBleedBoxOutput(outputPath, writtenBytes);
    return written.proof;
  } finally {
    if (Buffer.isBuffer(writtenBytes) && !buffersOverlap(writtenBytes, sourceBytes)) {
      writtenBytes.fill(0);
    }
    writtenBytes = null;
  }
}

async function reinspectCandidate({ core, sourceBytes, outputPath, request, writtenProof }) {
  const outputIdentity = await incrementalBleedBoxFileIdentity(outputPath);
  const outputBytes = await readStableIncrementalBleedBox(outputPath);
  let accepted = false;
  try {
    const proof = core.inspectIncrementalPdfBleedBox(sourceBytes, outputBytes, request);
    assertIncrementalBleedBoxProof(proof, sourceBytes.length, outputBytes.length, request);
    if (!isDeepStrictEqual(writtenProof, proof)
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
      fail(
        'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
        'Separate raw reinspection disagreed with the incremental BleedBox writer proof.',
      );
    }
    accepted = true;
    return { outputBytes, outputIdentity };
  } finally {
    if (!accepted) outputBytes.fill(0);
  }
}

async function validateCandidate({ poppler, job, signal, request, sourceSnapshot }) {
  const outputSnapshot = await inspectSupportedSnapshot({
    poppler,
    input: job.outputPath,
    workspace: job.workspace,
    signatureWorkspace: job.signatureWorkspace,
    signal,
  });
  if (!incrementalBleedBoxEnvelopeMatches(
    sourceSnapshot.envelope,
    outputSnapshot.envelope,
  )) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'Poppler observed an unexpected document-envelope or metadata change.',
    );
  }
  if (outputSnapshot.signatures.status !== 'unsigned'
    || outputSnapshot.signatures.signatureCount !== 0) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'Poppler did not observe the required unsigned BleedBox output.',
    );
  }
  if (!incrementalBleedBoxContentMatches(
    sourceSnapshot.content,
    outputSnapshot.content,
    request,
  )) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'Poppler did not observe only the requested BleedBox change with text and other boxes preserved.',
    );
  }
  await assertIncrementalBleedBoxRendersMatch({
    poppler,
    sourcePath: job.inputPath,
    outputPath: job.outputPath,
    workspace: job.workspace,
    signal,
    pageCount: sourceSnapshot.envelope.inspection.pageCount,
  });
}

async function assertSourceStillCurrent({ store, documentId, source, job }) {
  await assertPrivateSourceCopy({
    path: job.inputPath,
    identity: job.inputIdentity,
    expectedSha256: source.sha256,
    expectedSize: source.size,
    maximumBytes: MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES,
  });
  await store.verifySource(documentId);
}

export async function runIncrementalBleedBoxJob({
  store,
  poppler,
  core,
  documentId,
  source,
  request,
  deadline,
  lifecycle,
}) {
  const job = await createPrivateJob(
    store,
    documentId,
    source,
    deadline.signal,
    lifecycle,
  );
  const sourceSnapshot = await inspectSource({
    poppler,
    job,
    signal: deadline.signal,
    request,
  });
  lifecycle.sourceBytes = await readStableIncrementalBleedBox(
    job.inputPath,
    MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES,
  );
  if (lifecycle.sourceBytes.length !== source.size) {
    fail(
      'SOURCE_INTEGRITY_FAILED',
      'The private incremental BleedBox source changed before parsing.',
      500,
    );
  }

  const writtenProof = await writeCandidate({
    core,
    sourceBytes: lifecycle.sourceBytes,
    request,
    outputPath: job.outputPath,
  });
  await assertIncrementalBleedBoxWorkspace(job.workspace, INCREMENTAL_BLEED_BOX_AFTER_FILES);
  const candidate = await reinspectCandidate({
    core,
    sourceBytes: lifecycle.sourceBytes,
    outputPath: job.outputPath,
    request,
    writtenProof,
  });
  lifecycle.outputBytes = candidate.outputBytes;

  await validateCandidate({
    poppler,
    job,
    signal: deadline.signal,
    request,
    sourceSnapshot,
  });
  await assertIncrementalBleedBoxWorkspace(job.workspace, INCREMENTAL_BLEED_BOX_AFTER_FILES);
  await assertIncrementalBleedBoxFileIdentity(job.outputPath, candidate.outputIdentity);

  const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex');
  if (outputDigest === source.sha256) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'The incremental BleedBox output did not produce a distinct artifact digest.',
    );
  }
  await assertSourceStillCurrent({ store, documentId, source, job });
  throwIfAborted(deadline.signal);

  lifecycle.promotedArtifact = await promoteIncrementalBleedBoxArtifact({
    store,
    documentId,
    source,
    outputPath: job.outputPath,
    outputDigest,
    pageCount: sourceSnapshot.envelope.inspection.pageCount,
    request,
    signal: deadline.signal,
  });
  if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest
    || lifecycle.promotedArtifact.artifact.id === source.id) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'The promoted incremental BleedBox artifact does not match the validated output.',
    );
  }
  throwIfAborted(deadline.signal);
  lifecycle.completed = true;
  return lifecycle.promotedArtifact;
}
