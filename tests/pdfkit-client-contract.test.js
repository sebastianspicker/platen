import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactObject,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_METADATA_SANITIZATION_PROFILE,
  PDFKIT_MUTATION_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_PROTECTION_PROFILE,
  PDFKIT_PROTECTION_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  validPdfKitInkAnnotationMutation,
  validPdfKitLineAnnotationMutation,
  validPdfKitLocalGoToMutation,
  validPdfKitLocalGoToRemovalMutation,
  validPdfKitOutlineRemovalMutation,
  validPdfKitOutlineRenameMutation,
  validPdfKitMutation,
  validPdfKitProtection,
  validPdfKitProtectionRemoval,
  validPdfKitRectangle,
  validPdfKitTargetedMutation,
  validatePdfKitMetadataSanitizationResult,
  validatePdfKitProtectionRemovalResult,
} from '../src/core/pdfkit-client-contract.js';

const rectangle = { x: 10, y: 20, width: 30, height: 40 };

function assertPdfKitAnnotationPredicates() {
  const underline = {
    metadata: null,
    pageBox: null,
    rotation: null,
    annotations: [{ page: 1, subtype: 'underline', contents: 'underline', rect: rectangle }],
  };
  assert.equal(validPdfKitMutation(underline), true);
  for (const subtype of ['strikeOut', 'squiggly', 'stamp', 'ink', 'line', 'unknown']) {
    assert.equal(validPdfKitMutation({
      ...underline,
      annotations: [{ ...underline.annotations[0], subtype }],
    }), false, subtype);
  }
  assert.equal(validPdfKitMutation({
    ...underline,
    annotations: [{ ...underline.annotations[0], extra: true }],
  }), false);
  assert.equal(validPdfKitMutation({
    ...underline,
    annotations: [{ ...underline.annotations[0], contents: '' }],
  }), false);
  assert.equal(validPdfKitMutation({
    ...underline,
    annotations: [{ ...underline.annotations[0], contents: 'x'.repeat(1_025) }],
  }), false);
  for (const malformedRect of [
    { ...rectangle, width: 0 },
    { ...rectangle, height: 0 },
    { ...rectangle, extra: true },
  ]) {
    assert.equal(validPdfKitMutation({
      ...underline,
      annotations: [{ ...underline.annotations[0], rect: malformedRect }],
    }), false);
  }

  const targeted = {
    formFill: {
      page: 1, annotationIndex: 0, fingerprint: 'a'.repeat(64), fieldType: 'button', value: 'select',
    },
    annotationUpdate: null,
    annotationProperties: null,
    annotationRemove: null,
  };
  assert.equal(validPdfKitTargetedMutation(targeted), true);
  assert.equal(validPdfKitTargetedMutation({ ...targeted, unexpected: true }), false);
  const properties = {
    formFill: null,
    annotationUpdate: null,
    annotationProperties: {
      page: 1, annotationIndex: 1, fingerprint: 'a'.repeat(64), subtype: 'square',
      rect: rectangle, strokeColor: '#d32f2f',
    },
    annotationRemove: null,
  };
  assert.equal(validPdfKitTargetedMutation(properties), true);
  assert.equal(validPdfKitTargetedMutation({
    ...properties,
    annotationProperties: { ...properties.annotationProperties, strokeColor: '#D32F2F' },
  }), false);
  assert.equal(validPdfKitTargetedMutation({
    ...properties,
    annotationProperties: { ...properties.annotationProperties, subtype: 'circle' },
  }), false);
}

test('PDFKit client contract exports the exact fixed request profiles', () => {
  assert.deepEqual([
    PDFKIT_MUTATION_PROFILE,
    PDFKIT_TARGETED_PROFILE,
    PDFKIT_LOCAL_GOTO_PROFILE,
    PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
    PDFKIT_OUTLINE_PROFILE,
    PDFKIT_OUTLINE_REMOVAL_PROFILE,
    PDFKIT_OUTLINE_RENAME_PROFILE,
    PDFKIT_LINE_ANNOTATION_PROFILE,
    PDFKIT_INK_ANNOTATION_PROFILE,
    PDFKIT_PROTECTION_PROFILE,
    PDFKIT_PROTECTION_REMOVAL_PROFILE,
    PDFKIT_METADATA_SANITIZATION_PROFILE,
  ], [
    'macos-pdfkit-derived-v1',
    'macos-pdfkit-targeted-v1',
    'macos-pdfkit-local-goto-v1',
    'macos-pdfkit-local-goto-remove-v1',
    'macos-pdfkit-outline-v1',
    'macos-pdfkit-outline-remove-v1',
    'macos-pdfkit-outline-rename-v1',
    'macos-pdfkit-line-annotation-v1',
    'macos-pdfkit-ink-annotation-v1',
    'macos-pdfkit-aes128-v1',
    'macos-pdfkit-remove-protection-v1',
    'macos-pdfkit-metadata-sanitize-v1',
  ]);
});

test('PDFKit client request predicates retain strict exact-object bounds', () => {
  assert.equal(exactObject({ one: 1 }, ['one']), true);
  assert.equal(exactObject({ one: 1, extra: true }, ['one']), false);
  assert.equal(exactObject(Object.create({ one: 1 }), ['one']), false);
  assert.equal(validPdfKitRectangle(rectangle), true);
  assert.equal(validPdfKitRectangle({ ...rectangle, width: 0 }), false);

  const rotation = {
    metadata: null, pageBox: null, rotation: { page: 1, degrees: 90 }, annotations: [],
  };
  assert.equal(validPdfKitMutation(rotation), true);
  assert.equal(validPdfKitMutation({ ...rotation, metadata: { title: null, author: null, subject: null, keywords: null } }), false);

  assertPdfKitAnnotationPredicates();

  assert.equal(validPdfKitLocalGoToMutation({
    link: { sourcePage: 1, targetPage: 2, rect: rectangle },
  }), true);
  assert.equal(validPdfKitLocalGoToRemovalMutation({
    linkRemoval: { page: 1, annotationIndex: 0, fingerprint: 'a'.repeat(64) },
  }), true);
  assert.equal(validPdfKitLocalGoToRemovalMutation({
    linkRemoval: { page: 1, annotationIndex: 0, fingerprint: 'A'.repeat(64) },
  }), false);
  assert.equal(validPdfKitOutlineRemovalMutation({
    bookmarkRemoval: { topLevelIndex: 0, fingerprint: 'a'.repeat(64) },
  }), true);
  assert.equal(validPdfKitOutlineRemovalMutation({
    bookmarkRemoval: { topLevelIndex: 0, fingerprint: 'A'.repeat(64) },
  }), false);
  assert.equal(validPdfKitOutlineRenameMutation({
    bookmarkRename: {
      topLevelIndex: 0,
      fingerprint: 'a'.repeat(64),
      label: 'Renamed bookmark',
    },
  }), true);
  assert.equal(validPdfKitOutlineRenameMutation({
    bookmarkRename: {
      topLevelIndex: 0,
      fingerprint: 'a'.repeat(64),
      label: 'e\u0301',
    },
  }), false);
  assert.equal(validPdfKitLineAnnotationMutation({
    line: { page: 1, contents: 'line', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } },
  }), true);
  assert.equal(validPdfKitInkAnnotationMutation({
    ink: { page: 1, contents: 'ink', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
  }), true);
  assert.equal(validPdfKitInkAnnotationMutation({
    ink: { page: 1, contents: 'ink', points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] },
  }), false);

  assert.equal(validPdfKitProtection({
    permissionsProfile: 'deny-all', ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567',
  }), true);
  assert.equal(validPdfKitProtectionRemoval({
    artifactId: '11111111-1111-4111-8111-111111111111',
    artifactSha256: 'b'.repeat(64),
    ownerPassword: 'Owner-Pass-123',
  }), true);
});

test('PDFKit result validators retain exact typed host failures', () => {
  assert.throws(
    () => validatePdfKitProtectionRemovalResult(null, {}),
    {
      code: 'INVALID_LOCAL_HOST',
      message: 'The local host returned an invalid PDFKit protection-removal result.',
    },
  );
  assert.throws(
    () => validatePdfKitMetadataSanitizationResult(null, {}),
    {
      code: 'INVALID_LOCAL_HOST',
      message: 'The local host returned an invalid PDFKit metadata-sanitization result.',
    },
  );
});
