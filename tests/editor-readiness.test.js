import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';

const sourceDigest = 'a'.repeat(64);
const annotationFingerprint = 'b'.repeat(64);
const altTextLocator = 'c'.repeat(64);

function eligibleState() {
  const analysis = {
    status: 'ready', sha256: sourceDigest,
    inspection: {
      pageCount: 1, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no',
      title: null, author: null, subject: null, keywords: null,
    },
    structure: {
      xmpMetadata: { present: false }, urls: [],
      namedDestinations: { truncated: false, items: [] },
      pageBoxes: [{ page: 1, boxes: { cropBox: { left: 0, bottom: 0, right: 600, top: 800 } } }],
    },
    attachments: [], signatures: { status: 'unsigned', signatureCount: 0 },
  };
  return {
    analysis, busyAction: null, selectedPage: 1, viewerMode: 'native', ocrLanguages: ['eng'],
    host: {
      engines: [{ name: 'magick', available: true }, { name: 'gs', available: true }],
      pdfkitMutationReady: true, incrementalMetadataReady: true, incrementalBleedBoxReady: true,
      incrementalGoToLinkReady: true, incrementalNamedDestinationReady: true,
      incrementalPageVectorReady: true, pageTextReady: true, fullPageRedactionReady: true,
      incrementalAccessibilityMetadataReady: true, accessibilityRemediationReady: true,
      annotationFlattenReady: true, javascriptRemovalReady: true, attachmentRemovalReady: true,
      redactionPlansReady: true, redactionPlanReportsReady: true, pdfkitProtectionReady: true,
      pdfkitSanitizationReady: true, pdfkitTextFieldWidgetReady: true,
    },
    pdfkitInspectionResult: {
      sourceDigest, pageCount: 1,
      pages: [{
        index: 1, rotation: 0, annotationsTruncated: false,
        annotations: [{ page: 1, annotationIndex: 0, fingerprint: annotationFingerprint, subtype: 'square' }],
        widgets: [{ annotationIndex: 1, fieldType: 'text' }],
        boxes: {
          media: { x: 0, y: 0, width: 600, height: 800 },
          bleed: { x: 0, y: 0, width: 600, height: 800 },
          trim: { x: 20, y: 20, width: 560, height: 700 },
        },
      }],
      optionalContent: { present: false }, outline: { truncated: false, items: [] },
      pageLabels: { present: false },
    },
    pdfkitWidgetIndex: 1, pdfkitPageRotation: 90, pdfkitPageBox: 'bleed',
    pdfkitPageBoxRect: { x: 10, y: 10, width: 580, height: 780 },
    pdfkitLinkRect: { x: 10, y: 20, width: 70, height: 70 }, pdfkitLinkTargetPage: 1,
    pdfkitMetadata: { title: 'Local title', author: '', subject: '', keywords: '' },
    incrementalNamedDestinationTargetPage: 1, incrementalNamedDestinationName: 'chapter-1',
    incrementalPageVectorRect: { x: 10, y: 20, width: 70, height: 70 },
    pageTextRun: { x: 36, y: 72, size: 12, text: 'Hello PDF' },
    pdfkitExistingAnnotationIndex: 0,
    accessibilityDocumentLanguage: 'en', accessibilityDocumentTitle: 'Local title',
    accessibilityAltTextCandidateLocator: altTextLocator, accessibilityAltText: 'A red door beside a ramp.',
    accessibilityReviewResult: {
      kind: 'accessibility-review', sourceDigest,
      checks: [{ id: 'document-language', status: 'warning' }, { id: 'document-title', status: 'warning' }],
      remediationPlan: {
        truncated: false,
        candidates: [
          { action: 'set-document-language', status: 'proposed-not-applied' },
          { action: 'set-document-title', status: 'proposed-not-applied' },
          { action: 'author-image-alt-text', status: 'proposed-not-applied', target: { locator: altTextLocator } },
        ],
      },
    },
  };
}

function readiness(state) {
  return deriveEditorReadiness(state, state.analysis);
}

function changedKeys(before, after) {
  return Object.keys(before).filter((key) => !isDeepStrictEqual(before[key], after[key]));
}

function assertExactDelta(mutate, expected) {
  const state = eligibleState(); const before = readiness(state);
  mutate(state);
  assert.deepEqual(changedKeys(before, readiness(state)), expected);
}

test('editor readiness preserves its frozen public shape and eligible gate values', () => {
  const current = eligibleState();
  const expected = {
    ready: true, rasterAvailable: true, ghostscriptAvailable: true, ocrLanguages: ['eng'],
    redactionPlanReady: true, redactionPlanReportReady: true,
    incrementalMetadataReady: true, incrementalBleedBoxReady: true,
    incrementalGoToLinkReady: true, incrementalGoToLinkEditorReady: true,
    incrementalNamedDestinationReady: true, incrementalNamedDestinationEditorReady: true,
    incrementalPageVectorReady: true, incrementalPageVectorEditorReady: true,
    pageTextReady: true, pageTextEditorReady: true, fullPageRedactionReady: true,
    incrementalAccessibilityMetadataReady: true, incrementalAccessibilityMetadataEditorReady: true,
    accessibilityAltTextReady: true, accessibilityAltTextEditorReady: true,
    attachmentRemovalReady: false, javascriptRemovalReady: false, annotationFlattenReady: true,
    pdfkitMutationReady: true, pdfkitLegacyReady: true, pdfkitPageBoxEditorReady: true,
    pdfkitFormFillReady: false, pdfkitTextFieldWidgetReady: true,
    pdfkitExistingAnnotationReady: true, pdfkitLocalLinkReady: true, pdfkitLineReady: true,
    pdfkitInkReady: true, pdfkitLocalLinkRemovalReady: false, pdfkitOutlineReady: true,
    pdfkitOutlineRemovalReady: false, pdfkitOutlineRenameReady: false, pdfkitRotationReady: true,
    pdfkitPageBoxReady: true, pdfkitProtectionReady: true, pdfkitSanitizationReady: true,
    pdfkitProtectionRemovalReady: false, ocrCopyReady: true, ocrLayoutReady: true,
    snapshotReady: true, loupeReady: true,
  };
  const result = readiness(current);
  assert.deepEqual(Object.keys(result), Object.keys(expected));
  assert.deepEqual(result, expected);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.ocrLanguages), true);
});

test('editor readiness reacts independently to every capability-specific gate', () => {
  const scenarios = [
    ['annotation flatten', 'annotationFlattenReady', (state) => { state.pdfkitInspectionResult.pages[0].rotation = 90; }],
    ['incremental metadata', 'incrementalMetadataReady', (state) => { state.pdfkitMetadata.title = ''; }],
    ['incremental BleedBox', 'incrementalBleedBoxReady', (state) => { state.pdfkitPageBoxRect.x = 10.5; }],
    ['incremental GoTo link', 'incrementalGoToLinkReady', (state) => { state.pdfkitLinkRect.x = 10.5; }],
    ['incremental page vector', 'incrementalPageVectorReady', (state) => { state.incrementalPageVectorRect.x = 10.5; }],
    ['named destination', 'incrementalNamedDestinationReady', (state) => { state.incrementalNamedDestinationName = '!unsafe'; }],
    ['accessibility metadata', 'incrementalAccessibilityMetadataReady', (state) => { state.accessibilityDocumentLanguage = 'EN_us'; }],
    ['page text', 'pageTextReady', (state) => { state.pageTextRun.x = 36.5; }],
  ];
  for (const [name, key, mutate] of scenarios) {
    const current = structuredClone(eligibleState());
    mutate(current);
    assert.equal(readiness(current)[key], false, name);
  }

  const attachment = structuredClone(eligibleState());
  attachment.analysis.attachments = [{ number: 1, name: 'attached.txt' }];
  assert.equal(readiness(attachment).attachmentRemovalReady, true);
  attachment.analysis.attachments.push({ number: 2, name: 'second.txt' });
  assert.equal(readiness(attachment).attachmentRemovalReady, false);
  const javascript = structuredClone(eligibleState());
  javascript.analysis.inspection.javascript = 'yes';
  assert.equal(readiness(javascript).javascriptRemovalReady, true);
  javascript.analysis.signatures = { status: 'signed', signatureCount: 1 };
  assert.equal(readiness(javascript).javascriptRemovalReady, false);
});

test('editor readiness preserves exact status, busy, mutation, and host-gate deltas', () => {
  const unavailable = [
    'ready', 'redactionPlanReady', 'redactionPlanReportReady',
    'incrementalMetadataReady', 'incrementalBleedBoxReady',
    'incrementalGoToLinkReady', 'incrementalGoToLinkEditorReady',
    'incrementalNamedDestinationReady', 'incrementalNamedDestinationEditorReady',
    'incrementalPageVectorReady', 'incrementalPageVectorEditorReady',
    'pageTextReady', 'pageTextEditorReady', 'fullPageRedactionReady',
    'incrementalAccessibilityMetadataReady', 'incrementalAccessibilityMetadataEditorReady',
    'accessibilityAltTextReady', 'accessibilityAltTextEditorReady',
    'annotationFlattenReady', 'pdfkitMutationReady', 'pdfkitLegacyReady',
    'pdfkitPageBoxEditorReady', 'pdfkitTextFieldWidgetReady',
    'pdfkitExistingAnnotationReady', 'pdfkitLocalLinkReady', 'pdfkitLineReady',
    'pdfkitInkReady', 'pdfkitOutlineReady', 'pdfkitRotationReady', 'pdfkitPageBoxReady',
    'pdfkitProtectionReady', 'pdfkitSanitizationReady', 'ocrCopyReady', 'ocrLayoutReady',
    'snapshotReady', 'loupeReady',
  ];
  assertExactDelta((state) => { state.analysis.status = 'loading'; }, unavailable);
  assertExactDelta((state) => { state.busyAction = 'Saving'; }, unavailable);
  assertExactDelta((state) => { state.host.pdfkitMutationReady = false; }, [
    'pdfkitMutationReady', 'pdfkitLegacyReady', 'pdfkitExistingAnnotationReady',
    'pdfkitLocalLinkReady', 'pdfkitLineReady', 'pdfkitInkReady', 'pdfkitOutlineReady',
    'pdfkitRotationReady', 'pdfkitPageBoxReady',
  ]);

  for (const [gate, expected] of [
    ['incrementalMetadataReady', ['incrementalMetadataReady']],
    ['incrementalBleedBoxReady', ['incrementalBleedBoxReady']],
    ['incrementalGoToLinkReady', ['incrementalGoToLinkReady', 'incrementalGoToLinkEditorReady']],
    ['incrementalPageVectorReady', ['incrementalPageVectorReady', 'incrementalPageVectorEditorReady']],
    ['pageTextReady', ['pageTextReady', 'pageTextEditorReady']],
    ['fullPageRedactionReady', ['fullPageRedactionReady']],
  ]) assertExactDelta((state) => { state.host[gate] = false; }, expected);
});

test('editor readiness keeps copied and failure-prone inputs inert or fail-closed', () => {
  const sourceCopy = eligibleState(); const copied = readiness(sourceCopy);
  sourceCopy.ocrLanguages.push('deu');
  assert.deepEqual(copied.ocrLanguages, ['eng']);
  assert.notStrictEqual(copied.ocrLanguages, sourceCopy.ocrLanguages);

  const absentHost = eligibleState(); delete absentHost.host;
  const hostless = readiness(absentHost);
  assert.equal(hostless.ready, true);
  assert.equal(hostless.rasterAvailable, false);
  assert.equal(hostless.pdfkitMutationReady, undefined);
  assert.equal(hostless.incrementalMetadataReady, false);
  assert.equal(hostless.accessibilityAltTextReady, false);

  const stale = eligibleState(); stale.pdfkitInspectionResult.sourceDigest = 'd'.repeat(64);
  const staleReadiness = readiness(stale);
  assert.equal(staleReadiness.pdfkitMutationReady, false);
  assert.equal(staleReadiness.pdfkitLegacyReady, false);
  assert.equal(staleReadiness.incrementalBleedBoxReady, true);

  const absentInspection = eligibleState(); delete absentInspection.analysis.inspection;
  const inspectionless = readiness(absentInspection);
  assert.equal(inspectionless.ready, true);
  assert.equal(inspectionless.incrementalMetadataReady, false);
  assert.equal(inspectionless.incrementalGoToLinkReady, false);

  assert.throws(() => deriveEditorReadiness(eligibleState(), null), TypeError);
});
