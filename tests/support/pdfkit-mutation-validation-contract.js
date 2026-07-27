import {
  assert,
  checkPdfKitMutationLimits,
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  fingerprint,
  normalize,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  serializePdfKitMutationRequest,
  sourceSha256,
  test,
} from './pdfkit-mutation-contract-fixture.js';

const rejectsProfile = (profile, input) => assert.throws(() => normalize(profile, input), {
  code: 'INVALID_PDFKIT_MUTATION',
});

test('PDFKit mutation contract rejects profile drift and malformed edit shapes', () => {
  assert.throws(() => normalize('unknown-profile', {}), {
    code: 'INVALID_PDFKIT_MUTATION', status: 400,
  });
  rejectsProfile(PDFKIT_DERIVED_PROFILE, {
    metadata: { title: 'After', author: null, subject: null, keywords: null, extra: true },
    pageBox: null, rotation: null, annotations: [],
  });
  rejectsProfile(PDFKIT_TARGETED_PROFILE, {
    formFill: {
      page: 1, annotationIndex: 0, fingerprint, fieldType: 'button', value: 'maybe',
    },
    annotationUpdate: null, annotationRemove: null,
  });
  rejectsProfile(PDFKIT_LINE_ANNOTATION_PROFILE, {
    line: { page: 1, contents: 'Review', start: { x: 1, y: 2 }, end: { x: 1, y: 2 } },
  });
  rejectsProfile(PDFKIT_INK_ANNOTATION_PROFILE, {
    ink: { page: 1, contents: 'Review', points: [{ x: 1, y: 2 }, { x: 1, y: 2 }] },
  });
});

test('PDFKit mutation contract rejects unsafe link and outline identities', () => {
  for (const linkRemoval of [
    { page: 0, annotationIndex: 0, fingerprint },
    { page: 1, annotationIndex: -1, fingerprint },
    { page: 1, annotationIndex: 50, fingerprint },
    { page: 1, annotationIndex: 0, fingerprint: 'A'.repeat(64) },
    { page: 1, annotationIndex: 0, fingerprint, targetPage: 2 },
  ]) rejectsProfile(PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE, { linkRemoval });

  for (const bookmark of [
    { page: 0, label: 'Chapter' }, { page: 1, label: '' },
    { page: 1, label: ' edge' }, { page: 1, label: 'unsafe\u202E' },
    { page: 1, label: 'e\u0301' }, { page: 1, label: 'x'.repeat(1_025) },
    { page: 1, label: 'Chapter', action: 'GoTo' },
  ]) rejectsProfile(PDFKIT_OUTLINE_PROFILE, { bookmark });

  for (const bookmarkRemoval of [
    { topLevelIndex: -1, fingerprint }, { topLevelIndex: 200, fingerprint },
    { topLevelIndex: 0, fingerprint: 'A'.repeat(64) },
    { topLevelIndex: 0, fingerprint, label: 'spoof' },
  ]) rejectsProfile(PDFKIT_OUTLINE_REMOVAL_PROFILE, { bookmarkRemoval });

  for (const bookmarkRename of [
    { topLevelIndex: -1, fingerprint, label: 'Chapter' },
    { topLevelIndex: 200, fingerprint, label: 'Chapter' },
    { topLevelIndex: 0, fingerprint: 'A'.repeat(64), label: 'Chapter' },
    { topLevelIndex: 0, fingerprint, label: '' },
    { topLevelIndex: 0, fingerprint, label: ' edge' },
    { topLevelIndex: 0, fingerprint, label: 'unsafe\u202E' },
    { topLevelIndex: 0, fingerprint, label: 'e\u0301' },
    { topLevelIndex: 0, fingerprint, label: 'x'.repeat(1_025) },
    { topLevelIndex: 0, fingerprint, label: 'Chapter', oldLabel: 'private' },
  ]) rejectsProfile(PDFKIT_OUTLINE_RENAME_PROFILE, { bookmarkRename });
});

test('PDFKit mutation contract bounds helper resource limits', () => {
  const outline = normalize(PDFKIT_OUTLINE_PROFILE, {
    bookmark: { page: 1, label: 'Chapter' },
  });
  assert.throws(() => serializePdfKitMutationRequest(
    outline,
    { ...DEFAULT_PDFKIT_MUTATION_LIMITS, maxOutlineItems: 0 },
    sourceSha256,
  ), { code: 'INVALID_PDFKIT_MUTATION' });
  assert.throws(() => checkPdfKitMutationLimits({ maxPages: 101 }), TypeError);
  assert.throws(() => checkPdfKitMutationLimits({ unbounded: 1 }), TypeError);
  assert.deepEqual(checkPdfKitMutationLimits({ maxPages: 10 }), {
    ...DEFAULT_PDFKIT_MUTATION_LIMITS,
    maxPages: 10,
  });
});
