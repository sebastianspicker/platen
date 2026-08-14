const success = JSON.stringify({
  version: 1, ok: true, result: {
    document: { pageCount: 1, encrypted: false, locked: false, permissions: {
      copying: true, printing: true, changes: false, commenting: false, formFieldEntry: true,
      assembly: false, contentAccessibility: true, status: 'owner',
    }, supportedAnnotationTypes: ['text', 'link', 'freeText', 'line', 'square', 'circle', 'highlight', 'underline', 'strikeOut', 'ink', 'stamp', 'popup', 'widget', 'unknown'] },
    metadata: { title: null, author: null, subject: null, creator: null, producer: null, creationDate: null, modificationDate: null, keywords: null },
    pages: [{ index: 1, label: 'Front-i', rotation: 0, boxes: {
      media: { x: 0, y: 0, width: 612, height: 792 }, crop: { x: 0, y: 0, width: 612, height: 792 },
      bleed: { x: 0, y: 0, width: 612, height: 792 }, trim: { x: 0, y: 0, width: 612, height: 792 }, art: { x: 0, y: 0, width: 612, height: 792 },
    }, annotations: [{ subtype: 'link', annotationIndex: 0, fingerprint: 'b'.repeat(64) }], annotationsTruncated: false, widgets: [{ fieldName: 'name', fieldType: 'text', controlKind: null, flags: 0, annotationIndex: 1, fingerprint: 'c'.repeat(64) }], widgetsTruncated: false,
    links: [{ annotationIndex: 0, rect: { x: 72, y: 700, width: 180, height: 30 }, kind: 'goTo', targetPage: 1, target: null, remotePage: null }], linksTruncated: false }],
    pagesTruncated: false, outline: { items: [{ title: 'Chapter one', page: 1, children: [], removalLocator: null }], truncated: false },
    pageLabels: { present: true, items: [{ page: 1, label: 'Front-i' }], truncated: false },
    optionalContent: { present: true, groupCount: 1, groups: [{ index: 0, name: 'Review', defaultVisible: true }], groupsTruncated: false, defaultConfigurationPresent: true },
  },
});
const helperDigest = 'a'.repeat(64);
const mutationSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-mutation-receipt-v1', version: 1, operation: 'mutate', category: 'structure-mutation',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    appliedEdits: 4, inspection: JSON.parse(success).result,
  },
});
const localGoToSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-local-goto-receipt-v1', version: 1, operation: 'addLocalGoToLink',
    category: 'local-goto-link', sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    sourcePage: 1, targetPage: 2, annotationIndex: 0, pageCount: 2, appliedEdits: 1,
    rawDestinationVerified: true, localGoToActionVerified: true, reopenVerified: true,
  },
});
const localGoToRemovalSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-local-goto-removal-receipt-v1', version: 1,
    operation: 'removeLocalGoToLink', category: 'local-goto-link-removal',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    page: 1, annotationIndex: 0, pageCount: 2, appliedEdits: 1,
    rawTargetVerified: true, annotationRemoved: true,
    pageGeometryVerified: true, annotationInventoryVerified: true, reopenVerified: true,
  },
});
const outlineBookmarkSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-outline-bookmark-receipt-v1', version: 1,
    operation: 'appendOutlineBookmark', category: 'outline-bookmark',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    labelSha256: 'd'.repeat(64), page: 2, pageCount: 2, appliedEdits: 1,
    outlineAppended: true, destinationVerified: true,
    priorOutlineTreeVerified: true, pageGeometryVerified: true,
    annotationInventoryVerified: true, rawDestinationVerified: true, reopenVerified: true,
  },
});
const outlineBookmarkRemovalSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-outline-removal-receipt-v1', version: 1,
    operation: 'removeOutlineBookmark', category: 'outline-bookmark-removal',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    topLevelIndex: 0, pageCount: 2, appliedEdits: 1,
    rawTargetVerified: true, outlineRemoved: true, remainingOutlineTreeVerified: true,
    pageGeometryVerified: true, annotationInventoryVerified: true,
    contentSnapshotVerified: true, reopenVerified: true,
  },
});
const outlineBookmarkRenameSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-outline-rename-receipt-v1', version: 1,
    operation: 'renameOutlineBookmark', category: 'outline-bookmark-rename',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    topLevelIndex: 0, labelSha256: 'd'.repeat(64), pageCount: 2, appliedEdits: 1,
    rawTargetVerified: true, outlineRenamed: true, remainingOutlineTreeVerified: true,
    pageGeometryVerified: true, annotationInventoryVerified: true,
    contentSnapshotVerified: true, reopenVerified: true,
  },
});
const lineAnnotationSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-line-receipt-v1', version: 1, operation: 'addLineAnnotation',
    category: 'line-annotation', sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    page: 1, annotationIndex: 0, pageCount: 2, appliedEdits: 1,
    geometryVerified: true, lineStylesVerified: true, reopenVerified: true,
  },
});
const inkAnnotationSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-ink-receipt-v1', version: 1, operation: 'addInkAnnotation',
    category: 'ink-annotation', sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    page: 1, annotationIndex: 0, pageCount: 2, appliedEdits: 1,
    geometryVerified: true, rawInkListVerified: true, reopenVerified: true,
  },
});
const protectionSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-protection-receipt-v1', version: 1, operation: 'protect',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64), profile: 'accessibility-only',
    effectivePermissions: ['contentAccessibility'], effectivePermissionMask: 32, pageCount: 1,
    structuralSummary: { pageRotations: [0], annotationCounts: [1], annotationSubtypes: [['link']] },
  },
});
const protectionRemovalSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-deprotection-receipt-v1', version: 1, operation: 'removeProtection',
    sourceSha256: 'c'.repeat(64), outputSha256: 'd'.repeat(64), sourceProfile: 'accessibility-only',
    pageCount: 1, structuralSummary: {
      pageRotations: [0], annotationCounts: [1], annotationSubtypes: [['link']],
    },
    ownerAuthorizationVerified: true, encryptionRemoved: true, reopenVerified: true,
  },
});
const metadataSanitizationSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-metadata-sanitization-receipt-v1', version: 1,
    operation: 'sanitizeMetadata', sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
    pageCount: 1, observedCategories: ['document-info', 'custom-info', 'xmp'],
    freshDocumentCopy: true, metadataAbsent: true,
    contentSnapshotMatched: true, reopenVerified: true,
  },
});
const aecMeasurementSuccess = JSON.stringify({
  version: 1, ok: true, result: {
    schema: 'pdfkit-aec-measurement-receipt-v1', version: 1, operation: 'applyAecMeasurement',
    sourceSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64), measurementId: 'measurement-1',
    page: 1, kind: 'area', quantity: 0.09290304, unit: 'm2', calibrationId: 'calibration-1',
    annotationCount: 1, annotationSubtypes: ['ink'], measurementDictionaryEmbedded: false, pageCount: 1,
  },
});


export { aecMeasurementSuccess, helperDigest, inkAnnotationSuccess, lineAnnotationSuccess, localGoToRemovalSuccess, localGoToSuccess, metadataSanitizationSuccess, mutationSuccess, outlineBookmarkRemovalSuccess, outlineBookmarkRenameSuccess, outlineBookmarkSuccess, protectionRemovalSuccess, protectionSuccess, success };
