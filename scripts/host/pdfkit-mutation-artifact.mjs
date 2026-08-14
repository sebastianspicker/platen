import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';
import { freezePdfKitMutationResult } from './pdfkit-mutation-validation.mjs';

function operationType(normalized) {
  if (normalized.localGoTo) return 'pdfkit-local-goto-mutation';
  if (normalized.localGoToRemoval) return 'pdfkit-local-goto-removal';
  if (normalized.outlineBookmark) return 'pdfkit-outline-bookmark-mutation';
  if (normalized.outlineBookmarkRemoval) return 'pdfkit-outline-bookmark-removal';
  if (normalized.outlineBookmarkRename) return 'pdfkit-outline-bookmark-rename';
  if (normalized.lineAnnotation) return 'pdfkit-line-annotation-mutation';
  if (normalized.inkAnnotation) return 'pdfkit-ink-annotation-mutation';
  if (normalized.selectiveSanitization) return 'pdfkit-selective-sanitization';
  if (normalized.targeted) return 'pdfkit-targeted-mutation';
  return 'pdfkit-mutation';
}

function resultKind(normalized) {
  if (normalized.localGoTo) return 'pdfkit-local-goto-mutation';
  if (normalized.localGoToRemoval) return 'pdfkit-local-goto-removal';
  if (normalized.outlineBookmark) return 'pdfkit-outline-bookmark-mutation';
  if (normalized.outlineBookmarkRemoval) return 'pdfkit-outline-bookmark-removal';
  if (normalized.outlineBookmarkRename) return 'pdfkit-outline-bookmark-rename';
  if (normalized.lineAnnotation) return 'pdfkit-line-annotation-mutation';
  if (normalized.inkAnnotation) return 'pdfkit-ink-annotation-mutation';
  if (normalized.selectiveSanitization) return 'pdfkit-selective-sanitization';
  if (normalized.targeted) return 'pdfkit-targeted-mutation';
  return 'pdfkit-structure-mutation';
}

function displayName(source, normalized, pageBoxEvidence) {
  const stem = basename(source.displayName, extname(source.displayName));
  if (normalized.localGoTo) return `${stem}-local-link.pdf`;
  if (normalized.localGoToRemoval) return `${stem}-local-link-removed.pdf`;
  if (normalized.outlineBookmark) return `${stem}-bookmarked.pdf`;
  if (normalized.outlineBookmarkRemoval) return `${stem}-bookmark-removed.pdf`;
  if (normalized.outlineBookmarkRename) return `${stem}-bookmark-renamed.pdf`;
  if (normalized.lineAnnotation) return `${stem}-line-annotation.pdf`;
  if (normalized.inkAnnotation) return `${stem}-ink-annotation.pdf`;
  if (normalized.objectProperties) return `${stem}-annotation-properties.pdf`;
  if (normalized.mutation.rotation) {
    return `${stem}-page-${normalized.mutation.rotation.page}-rotated-${normalized.mutation.rotation.degrees}.pdf`;
  }
  if (pageBoxEvidence?.box === 'crop') return `${stem}-page-${pageBoxEvidence.page}-cropped.pdf`;
  if (pageBoxEvidence?.box === 'bleed') return `${stem}-page-${pageBoxEvidence.page}-bleed-box.pdf`;
  if (normalized.selectiveSanitization) return `${stem}-annotation-removed.pdf`;
  return `${stem}-pdfkit-edited.pdf`;
}

function limitations(normalized, pageBoxEvidence) {
  let operation;
  if (normalized.localGoTo) {
    operation = 'The new annotation contains only a redundant PDFKit-authored local GoTo action and destination; URI, remote-file, named, launch, and script actions are rejected.';
  } else if (normalized.localGoToRemoval) {
    operation = 'Exactly one source-bound strict local GoTo link annotation is removed while the ordered remaining annotation inventory and every page box and rotation are preserved.';
  } else if (normalized.outlineBookmark) {
    operation = 'One direct top-level local bookmark is appended. Existing direct-destination outline hierarchy and passive page geometry are preserved; sources with GoTo-action outlines are rejected because PDFKit normalizes their representation.';
  } else if (normalized.outlineBookmarkRemoval) {
    operation = 'Exactly one source-bound top-level leaf bookmark with a raw direct destination is removed while every remaining outline node, page snapshot, and ordered annotation inventory is preserved.';
  } else if (normalized.outlineBookmarkRename) {
    operation = 'Exactly one source-bound top-level leaf bookmark with a raw direct destination is renamed while every remaining outline node, page snapshot, and ordered annotation inventory is preserved.';
  } else if (normalized.lineAnnotation) {
    operation = 'The new annotation is one inert straight line with fixed no-ending styles; forms, actions, media, attachments, and presentation automation are rejected.';
  } else if (normalized.inkAnnotation) {
    operation = 'The new annotation is one inert open ink path with fixed appearance; forms, actions, media, attachments, and presentation automation are rejected.';
  } else if (normalized.selectiveSanitization) {
    operation = 'The selected page/index reachable annotation descriptor occurrence is omitted after reopen, while every other descriptor and its order are unchanged.';
  } else if (normalized.objectProperties) {
    operation = 'Only the exact source-bound inert Square annotation bounds and PDFKit border color change; target contents, flags, sensitive action shape, and every non-target descriptor order are verified after reopen.';
  } else if (normalized.radioSelection) {
    operation = 'The selected canonical radio widget is chosen through a privately validated parent-and-kids group; option names, prior state, current selection, and appearances are not returned.';
  } else if (normalized.mutation.rotation) {
    operation = 'The selected page receives one absolute persistent rotation; signed, encrypted, form-bearing, JavaScript-bearing, or no-op inputs are rejected.';
  } else if (pageBoxEvidence?.box === 'crop') {
    operation = 'Only the selected page CropBox changes. Expanding it can reveal source content that was previously outside the CropBox; signed, encrypted, form-bearing, JavaScript-bearing, out-of-MediaBox, and no-op inputs are rejected.';
  } else if (pageBoxEvidence?.box === 'bleed') {
    operation = 'Only the selected page resolved BleedBox changes. Signed, encrypted, form-bearing, JavaScript-bearing, out-of-MediaBox, and no-op inputs are rejected; explicit-versus-inherited source syntax is not claimed preserved.';
  } else {
    operation = 'Existing digital signatures can become invalid and unsupported PDF objects, actions, tags, layers, or appearances are not guaranteed to survive.';
  }
  return [
    'The source PDF is unchanged and the output is not rasterized, but PDFKit may rewrite object structure.',
    operation,
    normalized.selectiveSanitization || normalized.localGoToRemoval
      ? 'This is selective reachable-object removal, not redaction, hidden-data cleanup, orphan-byte scrubbing, prior-revision removal, or byte-preservation validation.'
      : 'This is not PDF/A, PDF/UA, PDF/X, redaction, sanitization, or byte-preservation validation.',
  ];
}

function validatorsFor(normalized, pageBoxEvidence) {
  return [
    'source-sha256',
    'pinned-helper-sha256',
    'pdfkit-effect-reopen',
    'poppler-page-count',
    'poppler-render-all-pages',
    ...(normalized.targeted ? ['source-bound-annotation-locator', 'native-active-content-graph'] : []),
    ...(normalized.objectProperties ? [
      'pdfkit-annotation-geometry-reopen', 'pdfkit-annotation-border-color-reopen',
      'raw-annotation-c-rgb', 'non-target-annotation-descriptors', 'target-annotation-preservation',
    ] : []),
    ...(normalized.radioSelection
      ? ['source-bound-radio-group', 'raw-radio-v-as-state', 'radio-render-change'] : []),
    ...(normalized.selectiveSanitization ? ['raw-reachable-annotation-delta'] : []),
    ...(normalized.localGoTo
      ? ['source-bound-local-goto', 'raw-destination-delta', 'local-goto-action-shape', 'native-active-content-graph'] : []),
    ...(normalized.localGoToRemoval
      ? ['source-bound-local-goto-locator', 'raw-local-goto-target', 'ordered-annotation-removal-delta', 'page-geometry-preservation', 'native-active-content-graph'] : []),
    ...(normalized.outlineBookmark
      ? ['source-bound-outline-label', 'direct-outline-tree-preservation', 'raw-outline-destination', 'page-geometry-preservation', 'annotation-inventory-preservation'] : []),
    ...(normalized.outlineBookmarkRemoval
      ? ['source-bound-outline-locator', 'raw-outline-target', 'direct-outline-removal-delta', 'page-geometry-preservation', 'annotation-inventory-preservation', 'content-snapshot-preservation'] : []),
    ...(normalized.outlineBookmarkRename
      ? ['source-bound-outline-locator', 'source-bound-outline-label', 'raw-outline-target', 'direct-outline-rename-delta', 'page-geometry-preservation', 'annotation-inventory-preservation', 'content-snapshot-preservation'] : []),
    ...(normalized.lineAnnotation
      ? ['source-bound-line-annotation', 'line-geometry-reopen', 'fixed-line-styles', 'native-active-content-graph'] : []),
    ...(normalized.inkAnnotation
      ? ['source-bound-ink-annotation', 'ink-geometry-reopen', 'raw-ink-list', 'native-active-content-graph'] : []),
    ...(normalized.mutation.rotation
      ? ['source-bound-page-rotation', 'pdfkit-rotation-reopen', 'poppler-page-rotation'] : []),
    ...(pageBoxEvidence?.box === 'crop' ? ['source-bound-cropbox', 'pdfkit-cropbox-reopen', 'poppler-cropbox'] : []),
    ...(pageBoxEvidence?.box === 'bleed' ? ['source-bound-bleedbox', 'pdfkit-bleedbox-reopen', 'poppler-bleedbox'] : []),
    ...(pageBoxEvidence?.box === 'bleed'
      ? ['poppler-render-equality-256px-all-pages'] : []),
  ];
}

function mutationEvidence(normalized, pageBoxEvidence) {
  return {
    engine: 'Apple PDFKit',
    helperBinaryDigestVerified: true,
    sourceDigestReverified: true,
    nativeEffectsReopened: true,
    popplerPageCountMatched: true,
    allPagesRendered: true,
    ...(normalized.localGoTo ? { rawDestinationVerified: true, localGoToActionVerified: true } : {}),
    ...(normalized.localGoToRemoval ? {
      rawLocalGoToTargetVerified: true,
      localGoToAnnotationRemoved: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
    } : {}),
    ...(normalized.outlineBookmark ? {
      outlineAppended: true,
      priorOutlineTreeVerified: true,
      rawDestinationVerified: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
    } : {}),
    ...(normalized.outlineBookmarkRemoval ? {
      rawOutlineTargetVerified: true,
      outlineRemoved: true,
      remainingOutlineTreeVerified: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
      contentSnapshotVerified: true,
    } : {}),
    ...(normalized.outlineBookmarkRename ? {
      rawOutlineTargetVerified: true,
      outlineRenamed: true,
      remainingOutlineTreeVerified: true,
      pageGeometryVerified: true,
      annotationInventoryVerified: true,
      contentSnapshotVerified: true,
    } : {}),
    ...(normalized.lineAnnotation ? { lineGeometryVerified: true, fixedLineStylesVerified: true } : {}),
    ...(normalized.inkAnnotation ? { inkGeometryVerified: true, rawInkListVerified: true } : {}),
    ...(normalized.objectProperties ? {
      annotationGeometryVerified: true, annotationBorderColorVerified: true,
      rawAnnotationColorVerified: true, nonTargetAnnotationDescriptorsVerified: true,
      targetAnnotationPreservationVerified: true,
    } : {}),
    ...(normalized.mutation.rotation ? { persistentPageRotationVerified: true } : {}),
    ...(pageBoxEvidence?.box === 'crop' ? { persistentCropBoxVerified: true } : {}),
    ...(pageBoxEvidence?.box === 'bleed' ? {
      persistentBleedBoxVerified: true,
      allPageValidationRendersMatched: true,
    } : {}),
    ...(normalized.radioSelection ? { canonicalRadioGroupSelectionVerified: true } : {}),
    ...(normalized.selectiveSanitization || normalized.localGoToRemoval
      ? { reachableAnnotationRemovalVerified: true } : {}),
    rasterized: false,
    sourceUnchanged: true,
  };
}

export async function promotePdfKitMutationArtifact({
  store,
  documentId,
  source,
  outputPath,
  signal,
  normalized,
  pageBoxEvidence,
  sourceInspection,
  outputInspection,
  outputDigest,
  nativeResult,
}) {
  const { summarizePdfKitMutation } = await import('./pdfkit-mutation-contract.mjs');
  const provenance = createOperationProvenance({
    type: operationType(normalized),
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: summarizePdfKitMutation(normalized.mutation),
    expected: {
      pageCount: sourceInspection.pageCount,
      rasterized: false,
      editCount: normalized.editCount,
    },
    validation: {
      passed: true,
      validators: validatorsFor(normalized, pageBoxEvidence),
      pageCount: outputInspection.pageCount,
      renderedPages: outputInspection.pageCount,
      appliedEdits: nativeResult.appliedEdits,
      outputSha256: outputDigest,
      ...(normalized.mutation.rotation ? {
        rotatedPage: normalized.mutation.rotation.page,
        pageRotation: normalized.mutation.rotation.degrees,
      } : {}),
      ...(pageBoxEvidence?.box === 'crop' ? {
        croppedPage: pageBoxEvidence.page,
        persistentCropBox: pageBoxEvidence.requestedPageBox,
      } : {}),
      ...(pageBoxEvidence?.box === 'bleed' ? {
        bleedBoxPage: pageBoxEvidence.page,
        persistentBleedBox: pageBoxEvidence.requestedPageBox,
      } : {}),
    },
  });
  const artifact = await store.promotePdfArtifact(documentId, outputPath, {
    displayName: displayName(source, normalized, pageBoxEvidence),
    operation: provenance,
    expectedSha256: outputDigest,
    signal,
  });
  return freezePdfKitMutationResult({
    kind: resultKind(normalized),
    sourceDigest: source.sha256,
    artifact,
    appliedEdits: nativeResult.appliedEdits,
    postflight: normalized.targeted || normalized.localGoTo || normalized.localGoToRemoval
      || normalized.outlineBookmark || normalized.outlineBookmarkRemoval || normalized.outlineBookmarkRename
      || normalized.lineAnnotation || normalized.inkAnnotation
      ? nativeResult
      : nativeResult.inspection,
    evidence: mutationEvidence(normalized, pageBoxEvidence),
    limitations: limitations(normalized, pageBoxEvidence),
  });
}
