import {
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_MUTATION_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_TARGETED_PROFILE,
} from './pdfkit-client-contract-shared.js';

const BASE_VALIDATORS = Object.freeze([
  'source-sha256',
  'pinned-helper-sha256',
  'pdfkit-effect-reopen',
  'poppler-page-count',
  'poppler-render-all-pages',
]);

const PROFILE_SHAPES = Object.freeze({
  [PDFKIT_MUTATION_PROFILE]: ['pdfkit-mutation', 'pdfkit-structure-mutation'],
  [PDFKIT_TARGETED_PROFILE]: ['pdfkit-targeted-mutation', 'pdfkit-targeted-mutation'],
  [PDFKIT_LOCAL_GOTO_PROFILE]: ['pdfkit-local-goto-mutation', 'pdfkit-local-goto-mutation'],
  [PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE]: ['pdfkit-local-goto-removal', 'pdfkit-local-goto-removal'],
  [PDFKIT_OUTLINE_PROFILE]: ['pdfkit-outline-bookmark-mutation', 'pdfkit-outline-bookmark-mutation'],
  [PDFKIT_OUTLINE_REMOVAL_PROFILE]: ['pdfkit-outline-bookmark-removal', 'pdfkit-outline-bookmark-removal'],
  [PDFKIT_OUTLINE_RENAME_PROFILE]: ['pdfkit-outline-bookmark-rename', 'pdfkit-outline-bookmark-rename'],
  [PDFKIT_LINE_ANNOTATION_PROFILE]: ['pdfkit-line-annotation-mutation', 'pdfkit-line-annotation-mutation'],
  [PDFKIT_INK_ANNOTATION_PROFILE]: ['pdfkit-ink-annotation-mutation', 'pdfkit-ink-annotation-mutation'],
});

function standardParameters(mutation) {
  return {
    metadataFields: mutation.metadata ? ['title', 'author', 'subject', 'keywords'] : [],
    pageBox: mutation.pageBox ? { page: mutation.pageBox.page, box: mutation.pageBox.box } : null,
    rotation: mutation.rotation
      ? { page: mutation.rotation.page, degrees: mutation.rotation.degrees } : null,
    annotations: mutation.annotations.map(({ page, subtype }) => ({ page, subtype })),
  };
}

function targetedParameters(mutation) {
  if (mutation.formFill) {
    const { fieldType, page, annotationIndex, value } = mutation.formFill;
    const category = fieldType === 'choice' && value === ''
      ? 'form-choice-clear'
      : fieldType === 'button' && value === 'select' ? 'form-radio-select' : 'form-fill';
    return { category, page, annotationIndex, fieldType };
  }
  if (mutation.annotationProperties) {
    const { page, annotationIndex, subtype } = mutation.annotationProperties;
    return { category: 'annotation-properties', page, annotationIndex, subtype };
  }
  const targeted = mutation.annotationUpdate ?? mutation.annotationRemove;
  return {
    category: mutation.annotationUpdate ? 'annotation-update' : 'annotation-remove',
    page: targeted.page,
    annotationIndex: targeted.annotationIndex,
    subtype: targeted.subtype,
  };
}

function parameters(profile, mutation) {
  if (profile === PDFKIT_MUTATION_PROFILE) return standardParameters(mutation);
  if (profile === PDFKIT_TARGETED_PROFILE) return targetedParameters(mutation);
  if (profile === PDFKIT_LOCAL_GOTO_PROFILE) return {
    category: 'local-goto-link',
    sourcePage: mutation.link.sourcePage,
    targetPage: mutation.link.targetPage,
  };
  if (profile === PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE) return {
    category: 'local-goto-link-removal',
    page: mutation.linkRemoval.page,
    annotationIndex: mutation.linkRemoval.annotationIndex,
  };
  if (profile === PDFKIT_OUTLINE_PROFILE) return {
    category: 'outline-bookmark', targetPage: mutation.bookmark.page,
  };
  if (profile === PDFKIT_OUTLINE_REMOVAL_PROFILE) return {
    category: 'outline-bookmark-removal', topLevelIndex: mutation.bookmarkRemoval.topLevelIndex,
  };
  if (profile === PDFKIT_OUTLINE_RENAME_PROFILE) return {
    category: 'outline-bookmark-rename', topLevelIndex: mutation.bookmarkRename.topLevelIndex,
  };
  if (profile === PDFKIT_LINE_ANNOTATION_PROFILE) return {
    category: 'line-annotation', page: mutation.line.page,
  };
  return { category: 'ink-annotation', page: mutation.ink.page };
}

function traits(profile, mutation) {
  return Object.freeze({
    rotation: profile === PDFKIT_MUTATION_PROFILE ? mutation.rotation : null,
    pageBox: profile === PDFKIT_MUTATION_PROFILE ? mutation.pageBox : null,
    radio: profile === PDFKIT_TARGETED_PROFILE
      && mutation.formFill?.fieldType === 'button' && mutation.formFill.value === 'select',
    selectiveRemoval: profile === PDFKIT_TARGETED_PROFILE && mutation.annotationRemove !== null,
    annotationProperties: profile === PDFKIT_TARGETED_PROFILE
      && mutation.annotationProperties !== null,
  });
}

function extraValidators(profile, value) {
  const {
    rotation, pageBox, radio, selectiveRemoval, annotationProperties,
  } = value;
  if (profile === PDFKIT_TARGETED_PROFILE) return [
    'source-bound-annotation-locator', 'native-active-content-graph',
    ...(radio ? ['source-bound-radio-group', 'raw-radio-v-as-state', 'radio-render-change'] : []),
    ...(selectiveRemoval ? ['raw-reachable-annotation-delta'] : []),
    ...(annotationProperties ? [
      'pdfkit-annotation-geometry-reopen', 'pdfkit-annotation-border-color-reopen',
      'raw-annotation-c-rgb', 'non-target-annotation-descriptors',
      'target-annotation-preservation',
    ] : []),
  ];
  if (profile === PDFKIT_LOCAL_GOTO_PROFILE) return [
    'source-bound-local-goto', 'raw-destination-delta', 'local-goto-action-shape',
    'native-active-content-graph',
  ];
  if (profile === PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE) return [
    'source-bound-local-goto-locator', 'raw-local-goto-target',
    'ordered-annotation-removal-delta', 'page-geometry-preservation',
    'native-active-content-graph',
  ];
  if (profile === PDFKIT_OUTLINE_PROFILE) return [
    'source-bound-outline-label', 'direct-outline-tree-preservation',
    'raw-outline-destination', 'page-geometry-preservation',
    'annotation-inventory-preservation',
  ];
  if (profile === PDFKIT_OUTLINE_REMOVAL_PROFILE) return [
    'source-bound-outline-locator', 'raw-outline-target', 'direct-outline-removal-delta',
    'page-geometry-preservation', 'annotation-inventory-preservation',
    'content-snapshot-preservation',
  ];
  if (profile === PDFKIT_OUTLINE_RENAME_PROFILE) return [
    'source-bound-outline-locator', 'source-bound-outline-label', 'raw-outline-target',
    'direct-outline-rename-delta', 'page-geometry-preservation',
    'annotation-inventory-preservation', 'content-snapshot-preservation',
  ];
  if (profile === PDFKIT_LINE_ANNOTATION_PROFILE) return [
    'source-bound-line-annotation', 'line-geometry-reopen', 'fixed-line-styles',
    'native-active-content-graph',
  ];
  if (profile === PDFKIT_INK_ANNOTATION_PROFILE) return [
    'source-bound-ink-annotation', 'ink-geometry-reopen', 'raw-ink-list',
    'native-active-content-graph',
  ];
  if (rotation) return [
    'source-bound-page-rotation', 'pdfkit-rotation-reopen', 'poppler-page-rotation',
  ];
  if (pageBox?.box === 'crop') return [
    'source-bound-cropbox', 'pdfkit-cropbox-reopen', 'poppler-cropbox',
  ];
  if (pageBox?.box === 'bleed') return [
    'source-bound-bleedbox', 'pdfkit-bleedbox-reopen', 'poppler-bleedbox',
    'poppler-render-equality-256px-all-pages',
  ];
  return [];
}

function extraEvidence(profile, value) {
  if (profile === PDFKIT_LOCAL_GOTO_PROFILE) return {
    rawDestinationVerified: true, localGoToActionVerified: true,
  };
  if (profile === PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE) return {
    rawLocalGoToTargetVerified: true, localGoToAnnotationRemoved: true,
    pageGeometryVerified: true, annotationInventoryVerified: true,
    reachableAnnotationRemovalVerified: true,
  };
  if (profile === PDFKIT_OUTLINE_PROFILE) return {
    outlineAppended: true, priorOutlineTreeVerified: true, rawDestinationVerified: true,
    pageGeometryVerified: true, annotationInventoryVerified: true,
  };
  if (profile === PDFKIT_OUTLINE_REMOVAL_PROFILE) return {
    rawOutlineTargetVerified: true, outlineRemoved: true, remainingOutlineTreeVerified: true,
    pageGeometryVerified: true, annotationInventoryVerified: true, contentSnapshotVerified: true,
  };
  if (profile === PDFKIT_OUTLINE_RENAME_PROFILE) return {
    rawOutlineTargetVerified: true, outlineRenamed: true, remainingOutlineTreeVerified: true,
    pageGeometryVerified: true, annotationInventoryVerified: true, contentSnapshotVerified: true,
  };
  if (profile === PDFKIT_LINE_ANNOTATION_PROFILE) return {
    lineGeometryVerified: true, fixedLineStylesVerified: true,
  };
  if (profile === PDFKIT_INK_ANNOTATION_PROFILE) return {
    inkGeometryVerified: true, rawInkListVerified: true,
  };
  return {
    ...(value.rotation ? { persistentPageRotationVerified: true } : {}),
    ...(value.pageBox?.box === 'crop' ? { persistentCropBoxVerified: true } : {}),
    ...(value.pageBox?.box === 'bleed' ? {
      persistentBleedBoxVerified: true, allPageValidationRendersMatched: true,
    } : {}),
    ...(value.radio ? { canonicalRadioGroupSelectionVerified: true } : {}),
    ...(value.selectiveRemoval ? { reachableAnnotationRemovalVerified: true } : {}),
    ...(value.annotationProperties ? {
      annotationGeometryVerified: true,
      annotationBorderColorVerified: true,
      rawAnnotationColorVerified: true,
      nonTargetAnnotationDescriptorsVerified: true,
      targetAnnotationPreservationVerified: true,
    } : {}),
  };
}

export function expectedPdfKitMutationResult(profile, mutation) {
  const shape = PROFILE_SHAPES[profile];
  const value = traits(profile, mutation);
  const selective = value.selectiveRemoval;
  return Object.freeze({
    type: selective ? 'pdfkit-selective-sanitization' : shape[0],
    kind: selective ? 'pdfkit-selective-sanitization' : shape[1],
    parameters: parameters(profile, mutation),
    editCount: profile === PDFKIT_MUTATION_PROFILE && mutation.metadata ? 4 : 1,
    validators: Object.freeze([...BASE_VALIDATORS, ...extraValidators(profile, value)]),
    evidence: Object.freeze({
      engine: 'Apple PDFKit', helperBinaryDigestVerified: true,
      sourceDigestReverified: true, nativeEffectsReopened: true,
      popplerPageCountMatched: true, allPagesRendered: true,
      ...extraEvidence(profile, value), rasterized: false, sourceUnchanged: true,
    }),
    rotation: value.rotation,
    pageBox: value.pageBox,
  });
}
