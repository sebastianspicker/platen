import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';

async function prepareJob({ deps, store, poppler, core, documentId, input }) {
  const { sourceSha256, signal: externalSignal, ...requestValue } = input;
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  const request = deps.checkedRequest(core, requestValue);
  const source = store.getDocument(documentId);
  if (!source || !deps.SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
    deps.fail('SOURCE_VERSION_MISMATCH', 'The page-text source digest does not match the current document.', 409);
  }
  if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > deps.MAX_SOURCE_BYTES) {
    deps.fail('PDF_PAGE_TEXT_INPUT_TOO_LARGE', 'Page-text insertion is limited to non-empty 128 MiB documents.', 413);
  }
  const deadline = deps.createDeadline(externalSignal, deps.MAX_JOB_MS);
  const context = {
    store, poppler, core, documentId, input, sourceSha256, externalSignal, request, source, deadline,
    workspaces: [], sourceBytes: null, writtenBytes: null, outputBytes: null,
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
      deps.fail('INVALID_PAGE_TEXT_OPTIONS', 'The selected page is outside the source document.', 400);
    }
    if (sourceSnapshot.content.textPages[request.page - 1]?.text !== '') {
      deps.fail('PDF_PAGE_TEXT_SOURCE_UNSUPPORTED', 'The selected page must be content-empty and text-free.', 422);
    }
    Object.assign(context, { workspace, signatureWorkspace, inputPath, outputPath, inputIdentity, sourceSnapshot });
    return context;
  } catch (error) {
    context.deadline.dispose();
    await deps.cleanupAfterJob({ store, workspaces: context.workspaces.reverse(), promotedArtifact: null, completed: false });
    throw deps.mapFailure(error, externalSignal, context.deadline);
  }
}

async function writeOutput(context, deps) {
  const { core, request, source, deadline, inputPath, outputPath } = context;
  context.sourceBytes = await deps.readSource(inputPath, source.size);
  deps.throwIfAborted(deadline.signal);
  const written = core.writeIncrementalPdfPageText(context.sourceBytes, request);
  context.writtenBytes = written?.bytes;
  if (!Buffer.isBuffer(context.writtenBytes) || deps.buffersOverlap(context.writtenBytes, context.sourceBytes)
    || context.writtenBytes.length <= context.sourceBytes.length || context.writtenBytes.length > deps.MAX_OUTPUT_BYTES
    || !written?.proof) {
    deps.fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The raw page-text writer returned an invalid result.');
  }
  const writtenDigest = createHash('sha256').update(context.writtenBytes).digest('hex');
  deps.assertPageTextWriterProof(written.proof, request, source.sha256, writtenDigest);
  if (!context.writtenBytes.subarray(0, context.sourceBytes.length).equals(context.sourceBytes)) {
    deps.fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The raw page-text writer changed the source prefix.');
  }
  deps.throwIfAborted(deadline.signal);
  await deps.writeOutput(outputPath, context.writtenBytes);
  context.writtenBytes.fill(0); context.writtenBytes = null;
  context.outputIdentity = await deps.fileIdentity(outputPath);
  await deps.assertWorkspace(context.workspace, deps.AFTER_FILES);
  context.outputBytes = await deps.readOutput(outputPath);
  if (!context.outputBytes.subarray(0, context.sourceBytes.length).equals(context.sourceBytes)) {
    deps.fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The staged page-text output did not preserve the source prefix.');
  }
  context.written = written;
}

async function validateAndPromote(context, deps) {
  const { request, source, poppler, deadline, inputPath, outputPath, sourceSnapshot } = context;
  const outputSnapshot = await deps.snapshot({
    poppler, input: outputPath, workspace: context.workspace,
    signatureWorkspace: context.signatureWorkspace, signal: deadline.signal,
  });
  if (!deps.passiveEnvelopeMatches(sourceSnapshot.envelope, outputSnapshot.envelope)
    || !deps.textOutputMatches(sourceSnapshot.content, outputSnapshot.content, request)) {
    deps.fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'Poppler did not confirm the exact text-only page change and preserved passive document evidence.');
  }
  await deps.assertRenders({
    poppler, sourcePath: inputPath, outputPath, workspace: context.workspace,
    signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount,
    targetPage: request.page,
  });
  await deps.assertWorkspace(context.workspace, deps.AFTER_FILES);
  await deps.assertFileIdentity(outputPath, context.outputIdentity);
  const outputDigest = createHash('sha256').update(context.outputBytes).digest('hex');
  if (outputDigest !== context.written.proof.outputSha256 || outputDigest === source.sha256
    || await deps.digestFile(outputPath) !== outputDigest) {
    deps.fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The page-text output digest changed or did not produce a distinct artifact.');
  }
  await deps.assertPrivateSourceCopy({
    path: inputPath, identity: context.inputIdentity, expectedSha256: source.sha256,
    expectedSize: source.size, maximumBytes: deps.MAX_SOURCE_BYTES,
  });
  await context.store.verifySource(context.documentId);
  deps.throwIfAborted(deadline.signal);
  const textSha256 = createHash('sha256').update(request.text, 'utf8').digest('hex');
  const operation = deps.createOperationProvenance({
    type: 'pdf-incremental-page-text',
    inputs: [{ documentId: context.documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: request.profile, page: request.page, x: request.x, y: request.y, size: request.size, textSha256 },
    expected: { pageCount: sourceSnapshot.envelope.inspection.pageCount, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
    validation: { passed: true, validators: deps.PDF_PAGE_TEXT_VALIDATORS, pageCount: outputSnapshot.envelope.inspection.pageCount, renderedPages: outputSnapshot.envelope.inspection.pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName ?? 'document.pdf', extname(source.displayName ?? 'document.pdf'));
  context.promotedArtifact = await context.store.promotePdfArtifact(context.documentId, outputPath, {
    displayName: `${stem}-page-text.pdf`, operation, expectedSha256: outputDigest, signal: deadline.signal,
  });
  if (!context.promotedArtifact || context.promotedArtifact.sha256 !== outputDigest
    || context.promotedArtifact.id === source.id || await deps.digestFile(outputPath) !== outputDigest) {
    deps.fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The promoted page-text artifact does not match the validated output.');
  }
  deps.throwIfAborted(deadline.signal);
  context.completed = true;
  return deps.freezeResult({
    kind: 'pdf-page-text-run', sourceDigest: source.sha256, artifact: context.promotedArtifact,
    page: request.page, text: { page: request.page, x: request.x, y: request.y, size: request.size, textSha256 },
    evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, writerProofVerified: true, pageCountMatched: true, pageBoxesMatched: true, targetPageTextMatched: true, targetPageRenderDiffered: true, otherPageRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: deps.PDF_PAGE_TEXT_LIMITATIONS, rasterized: false, historicalBytesRetained: true,
  });
}

export async function runPageTextInsert({ deps, store, poppler, core, documentId, input }) {
  let context;
  try {
    context = await prepareJob({ deps, store, poppler, core, documentId, input });
    await writeOutput(context, deps);
    return await validateAndPromote(context, deps);
  } catch (error) {
    if (!context) throw error;
    throw deps.mapFailure(error, context.externalSignal, context.deadline);
  } finally {
    if (context) {
      context.deadline.dispose();
      context.sourceBytes?.fill(0); context.writtenBytes?.fill(0); context.outputBytes?.fill(0);
      await deps.cleanupAfterJob({ store, workspaces: context.workspaces.reverse(), promotedArtifact: context.promotedArtifact, completed: context.completed });
    }
  }
}
