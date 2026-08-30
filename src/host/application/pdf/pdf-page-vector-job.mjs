import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { basename, extname, join } from 'node:path';

async function prepareJob({ deps, store, poppler, core, documentId, value, sourceSha256, externalSignal }) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  const request = deps.checkedRequest(core, value);
  const source = store.getDocument(documentId);
  if (!deps.SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
    deps.fail('SOURCE_VERSION_MISMATCH', 'The incremental page-vector source digest does not match the current document.', 409);
  }
  if (source.size < 5 || source.size > deps.MAX_SOURCE_BYTES) {
    deps.fail('INCREMENTAL_PAGE_VECTOR_INPUT_TOO_LARGE', 'Incremental page vectors are limited to non-empty 128 MiB documents.', 413);
  }
  const deadline = deps.createDeadline(externalSignal, deps.MAX_JOB_MS);
  const context = {
    store, poppler, core, documentId, sourceSha256, externalSignal, request, source, deadline,
    workspaces: [], sourceBytes: null, outputBytes: null, writtenBytes: null,
    promotedArtifact: null, completed: false,
  };
  try {
    deps.throwIfAborted(deadline.signal);
    await store.verifySource(documentId);
    const workspace = await store.createJobWorkspace(documentId);
    context.workspaces.push(workspace);
    const signatureWorkspace = await store.createJobWorkspace(documentId);
    context.workspaces.push(signatureWorkspace);
    const inputPath = join(workspace, 'input.pdf');
    const outputPath = join(workspace, 'output.pdf');
    const inputIdentity = await deps.stagePrivateSourceCopy({
      sourcePath: store.getSourcePath(documentId), targetPath: inputPath,
      expectedSha256: source.sha256, expectedSize: source.size,
      maximumBytes: deps.MAX_SOURCE_BYTES, signal: deadline.signal,
    });
    await deps.assertWorkspace(workspace, deps.BEFORE_FILES);
    const sourceSnapshot = await deps.snapshot({
      poppler, input: inputPath, workspace, signatureWorkspace, signal: deadline.signal,
    });
    if (request.page > sourceSnapshot.envelope.inspection.pageCount) {
      deps.fail('INVALID_INCREMENTAL_PAGE_VECTOR_OPTIONS', 'The selected page is outside the source document.', 400);
    }
    if (sourceSnapshot.content.textPages[request.page - 1]?.text !== '') {
      deps.fail('INCREMENTAL_PAGE_VECTOR_SOURCE_UNSUPPORTED', 'The selected page must be content-empty and text-free.', 422);
    }
    Object.assign(context, { workspace, signatureWorkspace, inputPath, outputPath, inputIdentity, sourceSnapshot });
    return context;
  } catch (error) {
    context.deadline.dispose();
    await deps.cleanupAfterJob({
      store, workspaces: context.workspaces.reverse(), promotedArtifact: null, completed: false,
    });
    throw deps.mapFailure(error, externalSignal, context.deadline);
  }
}

async function writeAndInspect(context, deps) {
  const { core, request, source, deadline, inputPath, outputPath } = context;
  context.sourceBytes = await deps.readPdf(inputPath, { source: true });
  if (context.sourceBytes.length !== source.size) {
    deps.fail('SOURCE_INTEGRITY_FAILED', 'The private incremental page-vector source changed before parsing.', 500);
  }
  deps.throwIfAborted(deadline.signal);
  const written = core.writeIncrementalPdfPageVector(context.sourceBytes, request);
  context.writtenBytes = written?.bytes;
  if (!Buffer.isBuffer(context.writtenBytes) || deps.overlap(context.writtenBytes, context.sourceBytes) || !written?.proof) {
    deps.fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The raw incremental page-vector writer returned an invalid result.');
  }
  deps.assertProof(written.proof, context.sourceBytes.length, context.writtenBytes.length, request);
  if (!context.writtenBytes.subarray(0, context.sourceBytes.length).equals(context.sourceBytes)) {
    deps.fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The raw incremental page-vector writer changed the source prefix.');
  }
  deps.throwIfAborted(deadline.signal);
  await deps.writePrivateOutput(outputPath, context.writtenBytes);
  context.writtenBytes.fill(0); context.writtenBytes = null;
  context.outputIdentity = await deps.fileIdentity(outputPath);
  await deps.assertWorkspace(context.workspace, deps.AFTER_FILES);
  context.outputBytes = await deps.readPdf(outputPath);
  const reinspectionProof = core.inspectIncrementalPdfPageVector(context.sourceBytes, context.outputBytes, request);
  deps.assertProof(reinspectionProof, context.sourceBytes.length, context.outputBytes.length, request);
  if (!isDeepStrictEqual(written.proof, reinspectionProof)
    || !context.outputBytes.subarray(0, context.sourceBytes.length).equals(context.sourceBytes)) {
    deps.fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the incremental page-vector writer proof.');
  }
  context.written = written;
}

async function validateAndPromote(context, deps) {
  const { request, source, poppler, deadline, inputPath, outputPath, sourceSnapshot } = context;
  const outputSnapshot = await deps.snapshot({
    poppler, input: outputPath, workspace: context.workspace,
    signatureWorkspace: context.signatureWorkspace, signal: deadline.signal,
  });
  if (outputSnapshot.envelope.inspection.pageCount !== sourceSnapshot.envelope.inspection.pageCount
    || outputSnapshot.signatures.status !== 'unsigned' || outputSnapshot.signatures.signatureCount !== 0
    || !isDeepStrictEqual(sourceSnapshot.content.pageBoxes, outputSnapshot.content.pageBoxes)
    || !isDeepStrictEqual(sourceSnapshot.content.textPages, outputSnapshot.content.textPages)) {
    deps.fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'Poppler observed an unexpected page count, text, boxes, or signature change.');
  }
  await deps.assertRenders({
    poppler, sourcePath: inputPath, outputPath, workspace: context.workspace,
    signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount,
    targetPage: request.page,
  });
  await deps.assertWorkspace(context.workspace, deps.AFTER_FILES);
  await deps.assertFileIdentity(outputPath, context.outputIdentity);
  await deps.assertPrivateSourceCopy({
    path: inputPath, identity: context.inputIdentity, expectedSha256: source.sha256,
    expectedSize: source.size, maximumBytes: deps.MAX_SOURCE_BYTES,
  });
  await context.store.verifySource(context.documentId);
  deps.throwIfAborted(deadline.signal);
  const outputDigest = createHash('sha256').update(context.outputBytes).digest('hex');
  if (outputDigest === source.sha256) deps.fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The incremental page-vector output did not produce a distinct artifact digest.');
  const operation = deps.createOperationProvenance({
    type: 'pdf-incremental-page-vector',
    inputs: [{ documentId: context.documentId, sha256: source.sha256, role: 'source' }],
    parameters: request,
    expected: { pageCount: sourceSnapshot.envelope.inspection.pageCount, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
    validation: { passed: true, validators: deps.PDF_PAGE_VECTOR_VALIDATORS, pageCount: sourceSnapshot.envelope.inspection.pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await context.store.promotePdfArtifact(context.documentId, outputPath, {
    displayName: `${stem}-page-vector.pdf`, operation, expectedSha256: outputDigest, signal: deadline.signal,
  });
  context.promotedArtifact = deps.freezeResult({
    kind: 'pdf-incremental-page-vector', sourceDigest: source.sha256, artifact,
    vector: { page: request.page, rect: request.rect },
    evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true, targetPageRenderDiffered: true, otherPageRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: deps.PDF_PAGE_VECTOR_LIMITATIONS,
  });
  if (context.promotedArtifact.artifact.sha256 !== outputDigest || context.promotedArtifact.artifact.id === source.id) {
    deps.fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The promoted page-vector artifact does not match the validated output.');
  }
  deps.throwIfAborted(deadline.signal);
  context.completed = true;
  return context.promotedArtifact;
}

export async function runPageVectorUpdate({ deps, store, poppler, core, documentId, value, sourceSha256, externalSignal }) {
  let context;
  try {
    context = await prepareJob({ deps, store, poppler, core, documentId, value, sourceSha256, externalSignal });
    await writeAndInspect(context, deps);
    return await validateAndPromote(context, deps);
  } catch (error) {
    if (!context) throw error;
    throw deps.mapFailure(error, externalSignal, context.deadline);
  } finally {
    if (context) {
      context.deadline.dispose();
      context.sourceBytes?.fill(0); context.outputBytes?.fill(0); context.writtenBytes?.fill(0);
      await deps.cleanupAfterJob({ store, workspaces: context.workspaces.reverse(), promotedArtifact: context.promotedArtifact, completed: context.completed });
    }
  }
}
