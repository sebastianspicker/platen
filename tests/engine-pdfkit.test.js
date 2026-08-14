import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePdfkitAecMeasurementResponse, parsePdfkitMutationResponse, parsePdfkitInkAnnotationResponse, parsePdfkitLineAnnotationResponse, parsePdfkitLocalGoToRemovalResponse, parsePdfkitLocalGoToResponse, parsePdfkitMetadataSanitizationResponse, parsePdfkitOutlineBookmarkRenameResponse, parsePdfkitOutlineBookmarkResponse, parsePdfkitProtectionRemovalResponse, parsePdfkitProtectionResponse, parsePdfkitResponse } from '../scripts/host/adapters/pdfkit.mjs';
import { aecMeasurementSuccess, inkAnnotationSuccess, lineAnnotationSuccess, localGoToRemovalSuccess, localGoToSuccess, metadataSanitizationSuccess, mutationSuccess, outlineBookmarkRenameSuccess, outlineBookmarkSuccess, protectionRemovalSuccess, protectionSuccess, success } from './support/engine-pdfkit-fixtures.js';
test('PDFKit response parser accepts bounded inventory and rejects malformed or oversized responses', () => {
  assert.equal(parsePdfkitResponse(success).pages[0].widgets[0].fieldName, 'name');
  assert.throws(() => parsePdfkitResponse('{"ok":true}'), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parsePdfkitResponse(success.replace('"link"', '"javascript"')), { code: 'INVALID_RESPONSE' });
  const malformedLocator = JSON.parse(success);
  malformedLocator.result.pages[0].annotations[0].fingerprint = 'B'.repeat(64);
  assert.throws(() => parsePdfkitResponse(JSON.stringify(malformedLocator)), { code: 'INVALID_RESPONSE' });
  const missingControlKind = JSON.parse(success);
  delete missingControlKind.result.pages[0].widgets[0].controlKind;
  assert.throws(() => parsePdfkitResponse(JSON.stringify(missingControlKind)), { code: 'INVALID_RESPONSE' });
  const mismatchedControlKind = JSON.parse(success);
  mismatchedControlKind.result.pages[0].widgets[0].controlKind = 'checkbox';
  assert.throws(() => parsePdfkitResponse(JSON.stringify(mismatchedControlKind)), { code: 'INVALID_RESPONSE' });
  const checkbox = JSON.parse(success);
  Object.assign(checkbox.result.pages[0].widgets[0], { fieldType: 'button', controlKind: 'checkbox' });
  assert.equal(parsePdfkitResponse(JSON.stringify(checkbox)).pages[0].widgets[0].controlKind, 'checkbox');
  assert.throws(() => parsePdfkitResponse('x'.repeat(524_289)), { code: 'RESPONSE_TOO_LARGE' });
  assert.throws(() => parsePdfkitResponse(JSON.stringify({ version: 1, ok: false, error: { code: 'UNREADABLE_DOCUMENT' } })), { code: 'UNREADABLE_DOCUMENT' });
  const unicodeBoundary = JSON.parse(success);
  unicodeBoundary.result.metadata.title = 'é'.repeat(512);
  assert.equal(parsePdfkitResponse(JSON.stringify(unicodeBoundary)).metadata.title.length, 512);
  unicodeBoundary.result.metadata.title += 'é';
  assert.throws(() => parsePdfkitResponse(JSON.stringify(unicodeBoundary)), { code: 'INVALID_RESPONSE' });
  const escapedOutline = JSON.parse(success);
  escapedOutline.result.outline.items[0].page = 2;
  assert.throws(() => parsePdfkitResponse(JSON.stringify(escapedOutline)), { code: 'INVALID_RESPONSE' });
  const mismatchedLabel = JSON.parse(success);
  mismatchedLabel.result.pageLabels.items[0].label = 'not-the-page-label';
  assert.throws(() => parsePdfkitResponse(JSON.stringify(mismatchedLabel)), { code: 'INVALID_RESPONSE' });
  const boundedLabel = JSON.parse(success);
  boundedLabel.result.pages[0].label = 'é'.repeat(512);
  boundedLabel.result.pageLabels.items[0].label = 'é'.repeat(512);
  assert.equal(Buffer.byteLength(parsePdfkitResponse(JSON.stringify(boundedLabel)).pageLabels.items[0].label, 'utf8'), 1_024);
  boundedLabel.result.pages[0].label += 'é';
  boundedLabel.result.pageLabels.items[0].label += 'é';
  assert.throws(() => parsePdfkitResponse(JSON.stringify(boundedLabel)), { code: 'INVALID_RESPONSE' });
  const activeLink = JSON.parse(success);
  activeLink.result.pages[0].links[0].kind = 'javascript';
  assert.throws(() => parsePdfkitResponse(JSON.stringify(activeLink)), { code: 'INVALID_RESPONSE' });
  const detachedLink = JSON.parse(success);
  detachedLink.result.pages[0].links[0].annotationIndex = 4;
  assert.throws(() => parsePdfkitResponse(JSON.stringify(detachedLink)), { code: 'INVALID_RESPONSE' });
  const invalidLayer = JSON.parse(success);
  invalidLayer.result.optionalContent.groups[0].index = 1;
  assert.throws(() => parsePdfkitResponse(JSON.stringify(invalidLayer)), { code: 'INVALID_RESPONSE' });
});

test('PDFKit mutation parser accepts only protocol edit counts and postflight inventory', () => {
  assert.equal(parsePdfkitMutationResponse(mutationSuccess).appliedEdits, 4);
  const single = JSON.parse(mutationSuccess); single.result.appliedEdits = 1;
  assert.equal(parsePdfkitMutationResponse(JSON.stringify(single)).appliedEdits, 1);
  const ambiguous = JSON.parse(mutationSuccess); ambiguous.result.appliedEdits = 2;
  assert.throws(() => parsePdfkitMutationResponse(JSON.stringify(ambiguous)), { code: 'INVALID_RESPONSE' });
  const zero = JSON.parse(mutationSuccess); zero.result.appliedEdits = 0;
  assert.throws(() => parsePdfkitMutationResponse(JSON.stringify(zero)), { code: 'INVALID_RESPONSE' });
  const extra = JSON.parse(mutationSuccess); extra.result.outputPath = '/private/output.pdf';
  assert.throws(() => parsePdfkitMutationResponse(JSON.stringify(extra)), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parsePdfkitMutationResponse(JSON.stringify({
    version: 1, ok: false, error: { code: 'MUTATION_FAILED' },
  })), { code: 'MUTATION_FAILED' });
});

test('PDFKit local GoTo parser accepts only a compact source-bound proof receipt', () => {
  assert.equal(parsePdfkitLocalGoToResponse(localGoToSuccess).targetPage, 2);
  for (const mutate of [
    (value) => { value.result.operation = 'mutate'; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.targetPage = 3; },
    (value) => { value.result.rawDestinationVerified = false; },
    (value) => { value.result.uri = 'https://example.invalid'; },
  ]) {
    const invalid = JSON.parse(localGoToSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitLocalGoToResponse(JSON.stringify(invalid)), { code: 'INVALID_RESPONSE' });
  }
});

test('PDFKit local GoTo removal parser accepts only a compact preservation receipt', () => {
  assert.equal(parsePdfkitLocalGoToRemovalResponse(localGoToRemovalSuccess).annotationIndex, 0);
  for (const mutate of [
    (value) => { value.result.operation = 'mutate'; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.page = 3; },
    (value) => { value.result.rawTargetVerified = false; },
    (value) => { value.result.annotationInventoryVerified = false; },
    (value) => { value.result.targetPage = 2; },
  ]) {
    const invalid = JSON.parse(localGoToRemovalSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitLocalGoToRemovalResponse(JSON.stringify(invalid)), {
      code: 'INVALID_RESPONSE',
    });
  }
});

test('PDFKit outline parser accepts only a compact preservation proof receipt', () => {
  assert.equal(parsePdfkitOutlineBookmarkResponse(outlineBookmarkSuccess).page, 2);
  for (const mutate of [
    (value) => { value.result.operation = 'mutate'; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.labelSha256 = 'D'.repeat(64); },
    (value) => { value.result.priorOutlineTreeVerified = false; },
    (value) => { value.result.rawDestinationVerified = false; },
    (value) => { value.result.label = 'must remain private'; },
  ]) {
    const invalid = JSON.parse(outlineBookmarkSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitOutlineBookmarkResponse(JSON.stringify(invalid)), {
      code: 'INVALID_RESPONSE',
    });
  }
});

test('PDFKit outline rename parser accepts only its compact source-bound receipt', () => {
  assert.equal(parsePdfkitOutlineBookmarkRenameResponse(outlineBookmarkRenameSuccess).topLevelIndex, 0);
  for (const mutate of [
    (value) => { value.result.operation = 'removeOutlineBookmark'; },
    (value) => { value.result.labelSha256 = 'not-a-sha256'; },
    (value) => { value.result.outlineRenamed = false; },
    (value) => { value.result.label = 'must remain private'; },
  ]) {
    const invalid = JSON.parse(outlineBookmarkRenameSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitOutlineBookmarkRenameResponse(JSON.stringify(invalid)), {
      code: 'INVALID_RESPONSE',
    });
  }
});

test('PDFKit line annotation parser accepts only a compact source-bound geometry receipt', () => {
  assert.equal(parsePdfkitLineAnnotationResponse(lineAnnotationSuccess).page, 1);
  for (const mutate of [
    (value) => { value.result.operation = 'mutate'; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.page = 3; },
    (value) => { value.result.geometryVerified = false; },
    (value) => { value.result.contents = 'must remain private'; },
  ]) {
    const invalid = JSON.parse(lineAnnotationSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitLineAnnotationResponse(JSON.stringify(invalid)), { code: 'INVALID_RESPONSE' });
  }
});

test('PDFKit ink annotation parser accepts only a compact source-bound geometry receipt', () => {
  assert.equal(parsePdfkitInkAnnotationResponse(inkAnnotationSuccess).page, 1);
  for (const mutate of [
    (value) => { value.result.operation = 'mutate'; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.page = 3; },
    (value) => { value.result.rawInkListVerified = false; },
    (value) => { value.result.points = [{ x: 1, y: 1 }]; },
  ]) {
    const invalid = JSON.parse(inkAnnotationSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitInkAnnotationResponse(JSON.stringify(invalid)), { code: 'INVALID_RESPONSE' });
  }
});

test('PDFKit protection parser accepts only the fixed public receipt', () => {
  assert.equal(parsePdfkitProtectionResponse(protectionSuccess).effectivePermissionMask, 32);
  for (const [profile, effectivePermissionMask, effectivePermissions] of [
    ['deny-all', 0, []],
    ['print-only', 3, ['printing']],
    ['copy-accessibility', 48, ['copying', 'contentAccessibility']],
  ]) {
    const receipt = JSON.parse(protectionSuccess);
    Object.assign(receipt.result, { profile, effectivePermissionMask, effectivePermissions });
    assert.equal(parsePdfkitProtectionResponse(JSON.stringify(receipt)).profile, profile);
  }
  for (const mutate of [
    (value) => { value.result.effectivePermissionMask = 31; },
    (value) => { value.result.effectivePermissions = []; },
    (value) => { value.result.profile = 'print-only'; },
    (value) => { value.result.structuralSummary.annotationCounts = [0]; },
    (value) => { value.result.structuralSummary.annotationSubtypes = [['javascript']]; },
    (value) => { value.result.password = 'must-never-appear'; },
  ]) {
    const invalid = JSON.parse(protectionSuccess);
    mutate(invalid);
    assert.throws(() => parsePdfkitProtectionResponse(JSON.stringify(invalid)), { code: 'INVALID_RESPONSE' });
  }
});

test('PDFKit protection-removal parser accepts only the compact owner-authorized receipt', () => {
  assert.equal(parsePdfkitProtectionRemovalResponse(protectionRemovalSuccess).encryptionRemoved, true);
  for (const mutate of [
    (value) => { value.result.sourceProfile = 'custom'; },
    (value) => { value.result.ownerAuthorizationVerified = false; },
    (value) => { value.result.encryptionRemoved = false; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.ownerPassword = 'must-never-appear'; },
  ]) {
    const invalid = JSON.parse(protectionRemovalSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitProtectionRemovalResponse(JSON.stringify(invalid)), { code: 'INVALID_RESPONSE' });
  }
});

test('PDFKit metadata-sanitization parser accepts only a category-bounded proof receipt', () => {
  assert.deepEqual(
    parsePdfkitMetadataSanitizationResponse(metadataSanitizationSuccess).observedCategories,
    ['document-info', 'custom-info', 'xmp'],
  );
  for (const mutate of [
    (value) => { value.result.operation = 'mutate'; },
    (value) => { value.result.outputSha256 = value.result.sourceSha256; },
    (value) => { value.result.observedCategories = []; },
    (value) => { value.result.observedCategories = ['xmp', 'document-info']; },
    (value) => { value.result.observedCategories = ['document-info', 'document-info']; },
    (value) => { value.result.metadataAbsent = false; },
    (value) => { value.result.metadataValue = 'must-never-escape'; },
  ]) {
    const invalid = JSON.parse(metadataSanitizationSuccess); mutate(invalid);
    assert.throws(
      () => parsePdfkitMetadataSanitizationResponse(JSON.stringify(invalid)),
      { code: 'INVALID_RESPONSE' },
    );
  }
});

test('PDFKit AEC parser accepts only source-bound inert annotation receipts', () => {
  assert.equal(parsePdfkitAecMeasurementResponse(aecMeasurementSuccess).annotationSubtypes[0], 'ink');
  for (const [kind, unit] of [['distance', 'm'], ['perimeter', 'm']]) {
    const linear = JSON.parse(aecMeasurementSuccess);
    Object.assign(linear.result, { kind, unit, annotationSubtypes: ['line'] });
    assert.equal(parsePdfkitAecMeasurementResponse(JSON.stringify(linear)).kind, kind);
  }
  const count = JSON.parse(aecMeasurementSuccess);
  Object.assign(count.result, {
    kind: 'count', quantity: 2, unit: 'count', calibrationId: null,
    annotationCount: 2, annotationSubtypes: ['circle', 'circle'],
  });
  assert.equal(parsePdfkitAecMeasurementResponse(JSON.stringify(count)).calibrationId, null);
  for (const [, mutate] of [
    ['embedded measurement dictionary', (value) => { value.result.measurementDictionaryEmbedded = true; }],
    ['invalid annotation subtype', (value) => { value.result.annotationSubtypes = ['javascript']; }],
    ['identical source and output digests', (value) => { value.result.outputSha256 = value.result.sourceSha256; }],
    ['missing calibration for an area measurement', (value) => { value.result.calibrationId = null; }],
    ['extra receipt field', (value) => { value.result.localPath = '/private/output.pdf'; }],
    ['missing receipt field', (value) => { delete value.result.pageCount; }],
    ['mismatched measurement unit', (value) => { value.result.unit = 'm'; }],
    ['count calibration', (value) => {
      Object.assign(value.result, { kind: 'count', quantity: 2, unit: 'count', annotationCount: 2, annotationSubtypes: ['circle', 'circle'] });
    }],
    ['count annotation subtype', (value) => {
      Object.assign(value.result, { kind: 'count', quantity: 2, unit: 'count', calibrationId: null, annotationCount: 2, annotationSubtypes: ['circle', 'ink'] });
    }],
    ['non-count annotation count', (value) => { value.result.annotationCount = 2; value.result.annotationSubtypes = ['ink', 'ink']; }],
    ['out-of-range page', (value) => { value.result.page = 101; }],
  ]) {
    const invalid = JSON.parse(aecMeasurementSuccess); mutate(invalid);
    assert.throws(() => parsePdfkitAecMeasurementResponse(JSON.stringify(invalid)), { code: 'INVALID_RESPONSE' });
  }
});
