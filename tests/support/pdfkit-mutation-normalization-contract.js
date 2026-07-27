import {
  assert,
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  fingerprint,
  normalize,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  serializePdfKitMutationRequest,
  sourceSha256,
  summarizePdfKitMutation,
  test,
} from './pdfkit-mutation-contract-fixture.js';

const serialized = (normalized) => JSON.parse(serializePdfKitMutationRequest(
  normalized,
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  sourceSha256,
));

test('PDFKit derived and targeted profiles normalize to exact helper requests', () => {
  const general = normalize(PDFKIT_DERIVED_PROFILE, {
    metadata: { title: 'After', author: null, subject: null, keywords: null },
    pageBox: null, rotation: null, annotations: [],
  });
  assert.equal(general.editCount, 4);
  assert.equal(general.requiresUnsigned, false);
  assert.deepEqual(summarizePdfKitMutation(general.mutation), {
    metadataFields: ['title', 'author', 'subject', 'keywords'],
    pageBox: null, rotation: null, annotations: [],
  });
  assert.deepEqual(serialized(general), {
    version: 1, operation: 'mutate', inputFilename: 'input.pdf',
    outputFilename: 'output.pdf', sourceSha256,
    limits: {
      maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50,
      maxOutlineDepth: 8, maxOutlineItems: 200,
    },
    mutation: general.mutation,
  });

  const targeted = normalize(PDFKIT_TARGETED_PROFILE, {
    formFill: {
      page: 1, annotationIndex: 0, fingerprint, fieldType: 'button', value: 'select',
    },
    annotationUpdate: null, annotationRemove: null,
  });
  assert.equal(targeted.targeted, true);
  assert.equal(targeted.radioSelection, true);
  assert.deepEqual(summarizePdfKitMutation(targeted.mutation), {
    category: 'form-radio-select', page: 1, annotationIndex: 0, fieldType: 'button',
  });
  assert.equal(serialized(targeted).operation, 'targetedMutate');
});

test('PDFKit navigation profiles serialize only their fixed operation envelope', () => {
  const localGoTo = normalize(PDFKIT_LOCAL_GOTO_PROFILE, {
    link: { sourcePage: 1, targetPage: 2, rect: { x: 10, y: 20, width: 30, height: 40 } },
  });
  const localRequest = serialized(localGoTo);
  assert.equal(localRequest.operation, 'addLocalGoToLink');
  assert.equal(localRequest.sourceSha256, sourceSha256);
  assert.deepEqual(summarizePdfKitMutation(localGoTo.mutation), {
    category: 'local-goto-link', sourcePage: 1, targetPage: 2,
  });

  const localGoToRemoval = normalize(PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE, {
    linkRemoval: { page: 1, annotationIndex: 0, fingerprint },
  });
  const removalRequest = serialized(localGoToRemoval);
  assert.equal(removalRequest.operation, 'removeLocalGoToLink');
  assert.equal(removalRequest.sourceSha256, sourceSha256);
  assert.deepEqual(removalRequest.link, { page: 1, annotationIndex: 0, fingerprint });
  assert.equal(Object.hasOwn(removalRequest, 'mutation'), false);
  assert.deepEqual(summarizePdfKitMutation(localGoToRemoval.mutation), {
    category: 'local-goto-link-removal', page: 1, annotationIndex: 0,
  });
});

test('PDFKit outline profiles serialize add, remove, and rename independently', () => {
  const outline = normalize(PDFKIT_OUTLINE_PROFILE, {
    bookmark: { page: 2, label: 'Appendix' },
  });
  const outlineRequest = serialized(outline);
  assert.equal(outlineRequest.operation, 'appendOutlineBookmark');
  assert.equal(outlineRequest.sourceSha256, sourceSha256);
  assert.deepEqual(outlineRequest.bookmark, { page: 2, label: 'Appendix' });
  assert.equal(Object.hasOwn(outlineRequest, 'mutation'), false);
  assert.deepEqual(summarizePdfKitMutation(outline.mutation), {
    category: 'outline-bookmark', targetPage: 2,
  });

  const removal = normalize(PDFKIT_OUTLINE_REMOVAL_PROFILE, {
    bookmarkRemoval: { topLevelIndex: 0, fingerprint },
  });
  const removalRequest = serialized(removal);
  assert.equal(removalRequest.operation, 'removeOutlineBookmark');
  assert.deepEqual(removalRequest.bookmark, { topLevelIndex: 0, fingerprint });
  assert.equal(Object.hasOwn(removalRequest, 'mutation'), false);
  assert.deepEqual(summarizePdfKitMutation(removal.mutation), {
    category: 'outline-bookmark-removal', topLevelIndex: 0,
  });

  const rename = normalize(PDFKIT_OUTLINE_RENAME_PROFILE, {
    bookmarkRename: { topLevelIndex: 0, fingerprint, label: 'Appendix renamed' },
  });
  const renameRequest = serialized(rename);
  assert.equal(renameRequest.operation, 'renameOutlineBookmark');
  assert.equal(renameRequest.sourceSha256, sourceSha256);
  assert.deepEqual(renameRequest.bookmarkRename, {
    topLevelIndex: 0, fingerprint, label: 'Appendix renamed',
  });
  assert.equal(Object.hasOwn(renameRequest, 'mutation'), false);
  assert.deepEqual(summarizePdfKitMutation(rename.mutation), {
    category: 'outline-bookmark-rename', topLevelIndex: 0,
  });
});

test('PDFKit drawing profiles serialize their dedicated operations', () => {
  const line = normalize(PDFKIT_LINE_ANNOTATION_PROFILE, {
    line: { page: 2, contents: 'Review', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } },
  });
  assert.equal(serialized(line).operation, 'addLineAnnotation');

  const ink = normalize(PDFKIT_INK_ANNOTATION_PROFILE, {
    ink: { page: 1, contents: 'Review', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  });
  assert.equal(serialized(ink).operation, 'addInkAnnotation');
  assert.ok(Object.isFrozen(ink.mutation.ink.points));
});
