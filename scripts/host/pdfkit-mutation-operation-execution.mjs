import { createHash } from 'node:crypto';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy } from './private-source-copy.mjs';
import { serializePdfKitMutationRequest } from './pdfkit-mutation-contract.mjs';
import {
  assertPdfKitFileIdentity,
  assertPdfKitOutput,
  assertPdfKitWorkspace,
  MAX_PDFKIT_SOURCE_BYTES,
  pdfKitFileIdentity,
  PDFKIT_WORKSPACE_AFTER_FILES,
  PDFKIT_WORKSPACE_BEFORE_FILES,
  writePrivatePdfKitRequest,
} from './pdfkit-mutation-validation.mjs';
import { fail } from './pdfkit-mutation-operation-errors.mjs';

async function dispatchMutation(adapter, normalized, workspace, requestPath, options) {
  const input = { workspacePath: workspace, requestPath };
  if (normalized.localGoTo) return adapter.addLocalGoToLink(input, options);
  if (normalized.localGoToRemoval) return adapter.removeLocalGoToLink(input, options);
  if (normalized.outlineBookmark) return adapter.appendOutlineBookmark(input, options);
  if (normalized.outlineBookmarkRemoval) return adapter.removeOutlineBookmark(input, options);
  if (normalized.outlineBookmarkRename) return adapter.renameOutlineBookmark(input, options);
  if (normalized.lineAnnotation) return adapter.addLineAnnotation(input, options);
  if (normalized.inkAnnotation) return adapter.addInkAnnotation(input, options);
  if (normalized.targeted) return adapter.targetedMutate(input, options);
  return adapter.mutate(input, options);
}

async function recheckImmutableInputs(context, requestIdentity, requestDigest) {
  await assertPdfKitFileIdentity(context.requestPath, requestIdentity);
  try {
    await assertPrivateSourceCopy({
      path: context.inputPath,
      identity: context.sourceCopyIdentity,
      expectedSha256: context.source.sha256,
      expectedSize: context.source.size,
      maximumBytes: MAX_PDFKIT_SOURCE_BYTES,
    });
  } catch (error) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'The private PDFKit source copy changed during native processing.',
      500,
      { cause: error },
    );
  }
  if (await digestFile(context.requestPath) !== requestDigest) {
    fail('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper changed its immutable inputs.', 502);
  }
}

export async function executePdfKitMutationOperation(context) {
  const request = serializePdfKitMutationRequest(
    context.normalized,
    context.limits,
    context.source.sha256,
  );
  await writePrivatePdfKitRequest(context.requestPath, request);
  const requestDigest = createHash('sha256').update(request).digest('hex');
  const requestIdentity = await pdfKitFileIdentity(context.requestPath);
  await assertPdfKitWorkspace(context.workspace, PDFKIT_WORKSPACE_BEFORE_FILES);
  const result = await dispatchMutation(
    context.adapter,
    context.normalized,
    context.workspace,
    context.requestPath,
    { signal: context.job.signal, timeoutMs: context.limits.timeoutMs },
  );
  await assertPdfKitWorkspace(context.workspace, PDFKIT_WORKSPACE_AFTER_FILES);
  await assertPdfKitOutput(context.outputPath);
  const outputIdentity = await pdfKitFileIdentity(context.outputPath);
  await recheckImmutableInputs(context, requestIdentity, requestDigest);
  return Object.freeze({ result, requestDigest, requestIdentity, outputIdentity });
}
