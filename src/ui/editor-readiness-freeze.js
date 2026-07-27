import {
  attachmentRemovalSourceReady,
  validArtifactId,
  validDigest,
} from './editor-readiness-helpers.js';

export function freezeEditorReadiness(values) {
  const {
    state, info, isEngineAvailable, ready, rasterAvailable, ocrLanguages,
    incrementalMetadataReady, incrementalBleedBoxReady, incrementalGoToLinkReady,
    incrementalGoToLinkEditorReady, namedDestinationReadiness,
    incrementalPageVectorReady, incrementalPageVectorEditorReady, pageTextReady,
    pageTextEditorReady, fullPageRedactionReady, accessibilityMetadataReadiness,
    altTextReadiness, unsigned, formKind, analysis, structure,
    javascriptRemovalReady, annotationFlattenReady, mutationReady, legacyReady,
    selectedWidget, existingAnnotations, localLinkReady, localGoToRemovalReady,
    boundedPageCount, outline, outlineCount, outlineRemovalReady, outlineRenameReady,
    requestedRotation, currentRotation, pageBoxReadiness, safeRewriteSource,
    protectedArtifact, snapshotGeometryReady, snapshotDpi,
  } = values;
  return Object.freeze({
    ready, rasterAvailable, ghostscriptAvailable: isEngineAvailable('gs'), ocrLanguages,
    redactionPlanReady: ready && rasterAvailable && state.host?.redactionPlansReady === true, redactionPlanReportReady: ready && state.host?.redactionPlanReportsReady === true,
    incrementalMetadataReady, incrementalBleedBoxReady,
    incrementalGoToLinkReady, incrementalGoToLinkEditorReady,
    incrementalNamedDestinationReady: namedDestinationReadiness.ready,
    incrementalNamedDestinationEditorReady: namedDestinationReadiness.editorReady,
    incrementalPageVectorReady, incrementalPageVectorEditorReady,
    pageTextReady, pageTextEditorReady, fullPageRedactionReady,
    incrementalAccessibilityMetadataReady: accessibilityMetadataReadiness.ready, incrementalAccessibilityMetadataEditorReady: accessibilityMetadataReadiness.editorReady,
    accessibilityAltTextReady: altTextReadiness.ready,
    accessibilityAltTextEditorReady: altTextReadiness.editorReady,
    attachmentRemovalReady: attachmentRemovalSourceReady({ state, ready, unsigned, info, formKind, analysis, structure }), javascriptRemovalReady,
    annotationFlattenReady,
    pdfkitMutationReady: mutationReady, pdfkitLegacyReady: legacyReady,
    pdfkitPageBoxEditorReady: incrementalBleedBoxReady || legacyReady,
    pdfkitFormFillReady: mutationReady && formKind === 'acroform' && Boolean(selectedWidget),
    pdfkitTextFieldWidgetReady: ready && state.host?.pdfkitTextFieldWidgetReady === true && unsigned && formKind === 'none'
      && Number.isSafeInteger(state.selectedPage) && state.selectedPage >= 1 && state.selectedPage <= (info?.pageCount ?? 0),
    pdfkitExistingAnnotationReady: legacyReady && existingAnnotations.length > 0,
    pdfkitLocalLinkReady: localLinkReady, pdfkitLineReady: localLinkReady, pdfkitInkReady: localLinkReady,
    pdfkitLocalLinkRemovalReady: localGoToRemovalReady,
    pdfkitOutlineReady: legacyReady && unsigned && boundedPageCount >= 1
      && outline?.truncated === false && outlineCount < 200,
    pdfkitOutlineRemovalReady: outlineRemovalReady, pdfkitOutlineRenameReady: outlineRenameReady,
    pdfkitRotationReady: legacyReady && unsigned && [0, 90, 180, 270].includes(requestedRotation) && currentRotation !== null && requestedRotation !== currentRotation,
    pdfkitPageBoxReady: pageBoxReadiness.verified
      ? legacyReady && unsigned && pageBoxReadiness.geometryReady && pageBoxReadiness.changed
      : legacyReady,
    pdfkitProtectionReady: safeRewriteSource && state.host?.pdfkitProtectionReady,
    pdfkitSanitizationReady: safeRewriteSource && state.host?.pdfkitSanitizationReady,
    pdfkitProtectionRemovalReady: state.pdfkitProtectionResult?.kind === 'pdfkit-password-protection'
      && state.host?.pdfkitProtectionReady && !state.busyAction
      && validArtifactId(protectedArtifact?.id) && validDigest(protectedArtifact?.sha256),
    ocrCopyReady: ready && ocrLanguages.length && (state.ocrCleanupPreset === 'none' || rasterAvailable),
    ocrLayoutReady: ready && ocrLanguages.length && rasterAvailable,
    snapshotReady: ready && snapshotGeometryReady && Number.isSafeInteger(snapshotDpi) && snapshotDpi >= 36 && snapshotDpi <= 240,
    loupeReady: ready && snapshotGeometryReady && state.viewerMode === 'native',
  });
}
