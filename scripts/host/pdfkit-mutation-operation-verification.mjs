import { createHash } from 'node:crypto';
import { digestFile } from './document-store.mjs';
import { pdfKitRectanglesMatch } from './pdfkit-mutation-validation.mjs';
import { validatePdfKitMutationOutput } from './pdfkit-mutation-output-validation.mjs';
import { fail } from './pdfkit-mutation-operation-errors.mjs';

function localGoToReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  return result.schema === 'pdfkit-local-goto-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.sourcePage === normalized.mutation.link.sourcePage
    && result.targetPage === normalized.mutation.link.targetPage
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.rawDestinationVerified === true
    && result.localGoToActionVerified === true
    && result.reopenVerified === true;
}

function localGoToRemovalReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  return result.schema === 'pdfkit-local-goto-removal-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.page === normalized.mutation.linkRemoval.page
    && result.annotationIndex === normalized.mutation.linkRemoval.annotationIndex
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.rawTargetVerified === true
    && result.annotationRemoved === true
    && result.pageGeometryVerified === true
    && result.annotationInventoryVerified === true
    && result.reopenVerified === true;
}

function outlineReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  const labelSha256 = createHash('sha256')
    .update(normalized.mutation.bookmark.label, 'utf8')
    .digest('hex');
  return result.schema === 'pdfkit-outline-bookmark-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.labelSha256 === labelSha256
    && result.page === normalized.mutation.bookmark.page
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.outlineAppended === true
    && result.destinationVerified === true
    && result.priorOutlineTreeVerified === true
    && result.pageGeometryVerified === true
    && result.annotationInventoryVerified === true
    && result.rawDestinationVerified === true
    && result.reopenVerified === true;
}

function outlineRemovalReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  return result.schema === 'pdfkit-outline-removal-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.topLevelIndex === normalized.mutation.bookmarkRemoval.topLevelIndex
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.rawTargetVerified === true
    && result.outlineRemoved === true
    && result.remainingOutlineTreeVerified === true
    && result.pageGeometryVerified === true
    && result.annotationInventoryVerified === true
    && result.contentSnapshotVerified === true
    && result.reopenVerified === true;
}

function outlineRenameReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  const labelSha256 = createHash('sha256')
    .update(normalized.mutation.bookmarkRename.label, 'utf8')
    .digest('hex');
  const keys = new Set([
    'schema', 'version', 'operation', 'category', 'sourceSha256', 'outputSha256',
    'topLevelIndex', 'labelSha256', 'pageCount', 'appliedEdits', 'rawTargetVerified',
    'outlineRenamed', 'remainingOutlineTreeVerified', 'pageGeometryVerified',
    'annotationInventoryVerified', 'contentSnapshotVerified', 'reopenVerified',
  ]);
  return Object.keys(result).length === keys.size
    && Object.keys(result).every((key) => keys.has(key))
    && result.schema === 'pdfkit-outline-rename-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.labelSha256 === labelSha256
    && result.topLevelIndex === normalized.mutation.bookmarkRename.topLevelIndex
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.rawTargetVerified === true
    && result.outlineRenamed === true
    && result.remainingOutlineTreeVerified === true
    && result.pageGeometryVerified === true
    && result.annotationInventoryVerified === true
    && result.contentSnapshotVerified === true
    && result.reopenVerified === true;
}

function lineReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  return result.schema === 'pdfkit-line-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.page === normalized.mutation.line.page
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.geometryVerified === true
    && result.lineStylesVerified === true
    && result.reopenVerified === true;
}

function inkReceiptValid(context) {
  const { result, source, sourceInspection, normalized } = context;
  return result.schema === 'pdfkit-ink-receipt-v1'
    && result.sourceSha256 === source.sha256
    && result.page === normalized.mutation.ink.page
    && result.pageCount === sourceInspection.pageCount
    && result.appliedEdits === normalized.editCount
    && result.geometryVerified === true
    && result.rawInkListVerified === true
    && result.reopenVerified === true;
}

function generalReceiptValid(context) {
  const { result, source, sourceInspection, normalized, pageBoxEvidence } = context;
  return result.schema === 'pdfkit-mutation-receipt-v1'
    && result.version === 1
    && result.operation === 'mutate'
    && result.category === 'structure-mutation'
    && result.sourceSha256 === source.sha256
    && typeof result.outputSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(result.outputSha256)
    && result.sourceSha256 !== result.outputSha256
    && result.appliedEdits === normalized.editCount
    && result.inspection.document.pageCount === sourceInspection.pageCount
    && result.inspection.pagesTruncated === false
    && result.inspection.pages.length === sourceInspection.pageCount
    && (!pageBoxEvidence || pdfKitRectanglesMatch(
      result.inspection.pages.find(({ index }) => index === pageBoxEvidence.page)?.boxes?.[pageBoxEvidence.box],
      pageBoxEvidence.requestedPageBox,
    ))
    && (!normalized.mutation.rotation
      || result.inspection.pages.find(
        ({ index }) => index === normalized.mutation.rotation.page,
      )?.rotation === normalized.mutation.rotation.degrees);
}

function nativeReceiptValid(context) {
  if (context.normalized.localGoTo) return localGoToReceiptValid(context);
  if (context.normalized.localGoToRemoval) return localGoToRemovalReceiptValid(context);
  if (context.normalized.outlineBookmark) return outlineReceiptValid(context);
  if (context.normalized.outlineBookmarkRemoval) return outlineRemovalReceiptValid(context);
  if (context.normalized.outlineBookmarkRename) return outlineRenameReceiptValid(context);
  if (context.normalized.lineAnnotation) return lineReceiptValid(context);
  if (context.normalized.inkAnnotation) return inkReceiptValid(context);
  return generalReceiptValid(context);
}

export async function verifyPdfKitMutationOperation(context) {
  if (!nativeReceiptValid(context)) {
    fail(
      'PDFKIT_POSTFLIGHT_INVALID',
      'The PDFKit helper postflight does not match the requested mutation.',
      502,
    );
  }
  const beforeValidationDigest = await digestFile(context.outputPath);
  if (context.result.outputSha256 !== beforeValidationDigest) {
    fail(
      'PDFKIT_POSTFLIGHT_INVALID',
      'The PDFKit source-bound receipt does not bind the validated output.',
      502,
    );
  }
  const validated = await validatePdfKitMutationOutput({
    poppler: context.poppler,
    store: context.store,
    documentId: context.documentId,
    workspace: context.workspace,
    signal: context.job.signal,
    timeoutMs: context.limits.timeoutMs,
    source: context.source,
    sourceInspection: context.sourceInspection,
    normalized: context.normalized,
    pageBoxEvidence: context.pageBoxEvidence,
    sourcePath: context.inputPath,
    outputPath: context.outputPath,
    outputIdentity: context.outputIdentity,
    requestPath: context.requestPath,
    requestIdentity: context.requestIdentity,
    requestDigest: context.requestDigest,
    sourceCopyIdentity: context.sourceCopyIdentity,
  });
  return Object.freeze({ validated, outputInspection: validated.outputInspection });
}
