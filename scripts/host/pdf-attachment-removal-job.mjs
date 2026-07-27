import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import {
  assertPrivateSourceCopy,
  stagePrivateSourceCopy,
} from './private-source-copy.mjs';
import { promotePdfAttachmentRemovalArtifact } from './pdf-attachment-removal-artifact.mjs';
import {
  MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES,
  PDF_ATTACHMENT_REMOVAL_BEFORE_FILES,
  assertPdfAttachmentRemovalFileIdentity,
  assertPdfAttachmentRemovalRendersMatch,
  assertPdfAttachmentRemovalWorkspace,
  assertProof,
  extractAttachmentBinding,
  inspectPdfAttachmentRemovalContent,
  inspectPdfAttachmentRemovalEnvelope,
  inventory,
  outputMatches,
  pdfAttachmentRemovalContentMatches,
  pdfAttachmentRemovalFileIdentity,
  readStablePdfAttachmentRemoval,
  sourceSupported,
  writePrivatePdfAttachmentRemovalOutput,
} from './pdf-attachment-removal-validation.mjs';

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

function aborted(signal) {
  if (signal.aborted) {
    throw signal.reason ?? new Error('Attachment removal was cancelled.');
  }
}

function overlap(left, right) {
  return left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}

async function snapshot(poppler, input, workspace, signatureWorkspace, signal) {
  const [envelope, signatures] = await Promise.all([
    inspectPdfAttachmentRemovalEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, {
      input, nssDirectory: signatureWorkspace, signal,
    }),
  ]);
  const attachmentsResult = await poppler.execute('listAttachments', { input }, {
    cwd: workspace, signal, timeoutMs: 30_000,
    maxStdoutBytes: 2 * 1024 * 1024, maxStderrBytes: 256 * 1024,
  });
  if (String(attachmentsResult?.stderr ?? '').trim()) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_POPPLER_WARNING',
      'Poppler reported a warning while listing attachments.',
      422,
    );
  }
  const content = await inspectPdfAttachmentRemovalContent(
    poppler,
    input,
    workspace,
    signal,
    envelope.inspection.pageCount,
  );
  return Object.freeze({
    envelope: Object.freeze({
      ...envelope,
      attachments: inventory(attachmentsResult.stdout),
    }),
    signatures,
    content,
  });
}

function removalBinding(request, attachment, binding) {
  return Object.freeze({
    profile: request.profile,
    nameSha256: createHash('sha256').update(attachment.name, 'utf8').digest('hex'),
    contentSha256: binding.contentSha256,
    contentBytes: binding.contentBytes,
  });
}

function assertWrittenResult(written, sourceBytes) {
  if (!written?.proof || !Buffer.isBuffer(written.bytes)
    || overlap(written.bytes, sourceBytes)) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
      'The raw attachment-removal writer returned an invalid result.',
    );
  }
}

async function stageWrittenOutput({
  core,
  sourceBytes,
  request,
  removal,
  outputPath,
}) {
  let written;
  try {
    written = core.writePdfAttachmentRemoval(sourceBytes, request);
    assertWrittenResult(written, sourceBytes);
    assertProof(written.proof, sourceBytes, written.bytes, request, removal);
    await writePrivatePdfAttachmentRemovalOutput(outputPath, written.bytes);
    return Object.freeze({ descriptor: written, proof: written.proof });
  } finally {
    if (Buffer.isBuffer(written?.bytes) && !overlap(written.bytes, sourceBytes)) {
      written.bytes.fill(0);
    }
  }
}

async function validateOutput({
  store,
  poppler,
  core,
  documentId,
  source,
  request,
  removal,
  deadline,
  lifecycle,
  workspace,
  signatureWorkspace,
  inputPath,
  outputPath,
  inputIdentity,
  attachmentPath,
  attachmentIdentity,
  before,
  written,
}) {
  lifecycle.outputBytes = await readStablePdfAttachmentRemoval(outputPath);
  const outputIdentity = await pdfAttachmentRemovalFileIdentity(outputPath);
  const proof = core.inspectPdfAttachmentRemoval(
    lifecycle.sourceBytes,
    lifecycle.outputBytes,
    request,
    written.descriptor,
  );
  assertProof(proof, lifecycle.sourceBytes, lifecycle.outputBytes, request, removal);
  if (!isDeepStrictEqual(written.proof, proof)) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
      'Separate attachment-removal inspection disagreed with the writer proof.',
    );
  }
  const after = await snapshot(
    poppler,
    outputPath,
    workspace,
    signatureWorkspace,
    deadline.signal,
  );
  if (!outputMatches(before.envelope, after.envelope)
    || after.signatures.status !== 'unsigned' || after.signatures.signatureCount !== 0
    || !pdfAttachmentRemovalContentMatches(before.content, after.content)) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
      'Poppler observed an unexpected attachment-removal document change.',
    );
  }
  await assertPdfAttachmentRemovalRendersMatch({
    poppler, sourcePath: inputPath, outputPath, workspace,
    signal: deadline.signal, pageCount: before.envelope.inspection.pageCount,
  });
  await assertPdfAttachmentRemovalFileIdentity(outputPath, outputIdentity);
  await assertPdfAttachmentRemovalFileIdentity(attachmentPath, attachmentIdentity);
  await assertPrivateSourceCopy({
    path: inputPath, identity: inputIdentity,
    expectedSha256: source.sha256, expectedSize: source.size,
    maximumBytes: MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES,
  });
  await store.verifySource(documentId);
}

export async function runPdfAttachmentRemovalJob({
  store,
  poppler,
  core,
  documentId,
  source,
  request,
  deadline,
  lifecycle,
}) {
  aborted(deadline.signal);
  await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId);
  lifecycle.workspaces.push(workspace);
  const signatureWorkspace = await store.createJobWorkspace(documentId);
  lifecycle.workspaces.push(signatureWorkspace);
  const inputPath = join(workspace, 'input.pdf');
  const outputPath = join(workspace, 'output.pdf');
  const attachmentPath = join(workspace, 'attachment.bin');
  const inputIdentity = await stagePrivateSourceCopy({
    sourcePath: store.getSourcePath(documentId), targetPath: inputPath,
    expectedSha256: source.sha256, expectedSize: source.size,
    maximumBytes: MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES,
    signal: deadline.signal,
  });
  await assertPdfAttachmentRemovalWorkspace(
    workspace,
    PDF_ATTACHMENT_REMOVAL_BEFORE_FILES,
  );
  const before = await snapshot(
    poppler,
    inputPath,
    workspace,
    signatureWorkspace,
    deadline.signal,
  );
  if (!sourceSupported(before.envelope, before.signatures)) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_SOURCE_UNSUPPORTED',
      'Attachment removal requires one passive unsigned attachment PDF.',
      422,
    );
  }
  const binding = await extractAttachmentBinding(
    poppler,
    inputPath,
    attachmentPath,
    workspace,
    deadline.signal,
  );
  const attachmentIdentity = await pdfAttachmentRemovalFileIdentity(attachmentPath);
  await assertPdfAttachmentRemovalWorkspace(
    workspace,
    ['attachment.bin', 'input.pdf'],
  );
  const removal = removalBinding(request, before.envelope.attachments[0], binding);
  lifecycle.sourceBytes = await readStablePdfAttachmentRemoval(
    inputPath,
    MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES,
  );
  if (lifecycle.sourceBytes.length !== source.size) {
    fail(
      'SOURCE_INTEGRITY_FAILED',
      'The private attachment-removal source changed before raw parsing.',
      500,
    );
  }
  const written = await stageWrittenOutput({
    core, sourceBytes: lifecycle.sourceBytes, request, removal, outputPath,
  });
  await assertPdfAttachmentRemovalWorkspace(
    workspace,
    ['attachment.bin', 'input.pdf', 'output.pdf'],
  );
  await validateOutput({
    store, poppler, core, documentId, source, request, removal, deadline, lifecycle,
    workspace, signatureWorkspace, inputPath, outputPath, inputIdentity,
    attachmentPath, attachmentIdentity, before, written,
  });
  aborted(deadline.signal);
  const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex');
  if (outputDigest === source.sha256) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
      'Attachment-removal output did not produce a distinct artifact digest.',
    );
  }
  lifecycle.promotedArtifact = await promotePdfAttachmentRemovalArtifact({
    store, documentId, source, outputPath, outputDigest,
    pageCount: before.envelope.inspection.pageCount, removal,
    signal: deadline.signal,
  });
  if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest
    || lifecycle.promotedArtifact.artifact.id === source.id) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
      'Promoted attachment-removal artifact did not match validated output.',
    );
  }
  aborted(deadline.signal);
  lifecycle.completed = true;
  return lifecycle.promotedArtifact;
}
