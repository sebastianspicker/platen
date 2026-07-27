import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPdfKitInkAnnotationMutation,
  buildPdfKitLineAnnotationMutation,
  buildPdfKitLocalGoToMutation,
  buildPdfKitLocalGoToRemovalMutation,
  buildPdfKitMutation,
  buildPdfKitOutlineMutation,
  buildPdfKitOutlineRemovalMutation,
  buildPdfKitOutlineRenameMutation,
  buildPdfKitTargetedMutation,
  isSupportedPdfKitFormWidget,
  normalizePdfKitProtection,
  normalizePdfKitProtectionRemoval,
} from '../src/core/pdfkit-workflow-contract.js';

const widgetFingerprint = 'a'.repeat(64);
const annotationFingerprint = 'b'.repeat(64);
const linkFingerprint = 'd'.repeat(64);
const outlineFingerprint = 'e'.repeat(64);
const artifactSha256 = 'c'.repeat(64);

function workflowState(overrides = {}) {
  return {
    selectedPage: 1,
    pdfkitInspectionResult: {
      pageCount: 2,
      pages: [{
        index: 1,
        boxes: {
          media: { x: 0, y: 0, width: 612, height: 792 },
          crop: { x: 10, y: 20, width: 500, height: 700 },
          bleed: { x: 5, y: 10, width: 590, height: 760 },
          trim: { x: 20, y: 30, width: 560, height: 720 },
        },
        widgets: [
          { annotationIndex: 3, fieldType: 'text', controlKind: null, fingerprint: widgetFingerprint },
          { annotationIndex: 4, fieldType: 'button', controlKind: 'checkbox', fingerprint: widgetFingerprint },
          { annotationIndex: 5, fieldType: 'button', controlKind: 'radio', fingerprint: widgetFingerprint },
        ],
        annotations: [
          { annotationIndex: 0, subtype: 'link', fingerprint: linkFingerprint },
          { annotationIndex: 7, subtype: 'freeText', fingerprint: annotationFingerprint },
        ],
        annotationsTruncated: false,
        links: [{
          annotationIndex: 0, kind: 'goTo', targetPage: 2,
          target: null, remotePage: null, rect: { x: 30, y: 40, width: 140, height: 24 },
        }],
        linksTruncated: false,
      }],
      outline: {
        items: [{
          title: 'Existing appendix', page: 2, children: [],
          removalLocator: { topLevelIndex: 0, fingerprint: outlineFingerprint },
        }],
        truncated: false,
      },
    },
    pdfkitMetadata: { title: 'Title', author: '', subject: 'Subject', keywords: '' },
    pdfkitPageBox: 'crop',
    pdfkitPageBoxRect: { x: 12, y: 22, width: 490, height: 690 },
    pdfkitPageRotation: '90',
    pdfkitAnnotationSubtype: 'freeText',
    pdfkitAnnotationContents: 'Review note',
    pdfkitAnnotationRect: { x: 36, y: 40, width: 180, height: 80 },
    pdfkitWidgetIndex: '3',
    pdfkitFormValue: 'Approved',
    pdfkitButtonState: 'on',
    pdfkitExistingAnnotationIndex: '7',
    pdfkitExistingAnnotationContents: 'Updated note',
    pdfkitExistingAnnotationRect: { x: 40, y: 45, width: 170, height: 70 },
    pdfkitLinkTargetPage: '2',
    pdfkitLocalLinkRemovalIndex: '0',
    pdfkitLinkRect: { x: 30, y: 40, width: 140, height: 24 },
    pdfkitOutlineLabel: 'Appendix',
    pdfkitOutlineTargetPage: '2',
    pdfkitOutlineRemovalIndex: '0',
    pdfkitOutlineRenameIndex: '0',
    pdfkitOutlineRenameLabel: 'Renamed appendix',
    pdfkitLineContents: 'Review line',
    pdfkitLineStart: { x: 40, y: 50 },
    pdfkitLineEnd: { x: 180, y: 210 },
    pdfkitInkContents: 'Review ink',
    pdfkitInkPoints: '40,50;90,120;180,210',
    ...overrides,
  };
}

test('derived PDFKit builders return the exact metadata, page-box, rotation, and annotation shapes', () => {
  const state = workflowState();
  assert.deepEqual(buildPdfKitMutation('metadata', state), {
    metadata: { title: 'Title', author: null, subject: 'Subject', keywords: null },
    pageBox: null,
    rotation: null,
    annotations: [],
  });
  assert.deepEqual(buildPdfKitMutation('page-box', state), {
    metadata: null,
    pageBox: { page: 1, box: 'crop', rect: { x: 12, y: 22, width: 490, height: 690 } },
    rotation: null,
    annotations: [],
  });
  assert.deepEqual(buildPdfKitMutation('rotation', state), {
    metadata: null, pageBox: null, rotation: { page: 1, degrees: 90 }, annotations: [],
  });
  assert.deepEqual(buildPdfKitMutation('annotation', state), {
    metadata: null,
    pageBox: null,
    rotation: null,
    annotations: [{
      page: 1,
      subtype: 'freeText',
      contents: 'Review note',
      rect: { x: 36, y: 40, width: 180, height: 80 },
    }],
  });
});

test('derived PDFKit builders retain exact bounded input errors', () => {
  assert.throws(
    () => buildPdfKitMutation('metadata', workflowState({ pdfkitMetadata: { title: 'x'.repeat(1_025) } })),
    { message: 'PDF metadata title exceeds 1,024 UTF-8 bytes.' },
  );
  assert.throws(
    () => buildPdfKitMutation('page-box', workflowState({
      pdfkitPageBoxRect: { x: 10, y: 20, width: 500, height: 700 },
    })),
    { message: 'Choose a CropBox that differs from the selected page’s current CropBox.' },
  );
  assert.throws(
    () => buildPdfKitMutation('page-box', workflowState({
      pdfkitPageBox: 'bleed',
      pdfkitPageBoxRect: { x: 5, y: 10, width: 590, height: 760 },
    })),
    { message: 'Choose a BleedBox that differs from the selected page’s current BleedBox.' },
  );
  assert.throws(
    () => buildPdfKitMutation('page-box', workflowState({
      pdfkitPageBox: 'bleed',
      pdfkitPageBoxRect: { x: 30, y: 40, width: 540, height: 700 },
    })),
    { message: 'Choose a BleedBox that fully contains the selected page’s TrimBox.' },
  );
  assert.throws(
    () => buildPdfKitMutation('page-box', workflowState({
      pdfkitPageBoxRect: { x: 600, y: 0, width: 20, height: 100 },
    })),
    { message: 'Page box must be fully contained in the inspected MediaBox for page 1.' },
  );
  assert.throws(
    () => buildPdfKitMutation('annotation', workflowState({ pdfkitAnnotationContents: '' })),
    { message: 'Annotation contents must contain 1 through 1,024 UTF-8 bytes.' },
  );
});

test('targeted PDFKit builder binds form values to inspected widget identity', () => {
  const text = buildPdfKitTargetedMutation('form-fill', workflowState());
  assert.deepEqual(text, {
    formFill: {
      page: 1, annotationIndex: 3, fingerprint: widgetFingerprint, fieldType: 'text', value: 'Approved',
    },
    annotationUpdate: null,
    annotationRemove: null,
  });
  const checkbox = buildPdfKitTargetedMutation('form-fill', workflowState({
    pdfkitWidgetIndex: '4', pdfkitButtonState: 'off',
  }));
  assert.equal(checkbox.formFill.value, 'off');
  const radio = buildPdfKitTargetedMutation('form-fill', workflowState({ pdfkitWidgetIndex: '5' }));
  assert.equal(radio.formFill.value, 'select');
  assert.equal(isSupportedPdfKitFormWidget({ fieldType: 'button', controlKind: 'push' }), false);
});

test('targeted annotation update and removal retain exact source locators', () => {
  const state = workflowState();
  assert.deepEqual(buildPdfKitTargetedMutation('annotation-update', state), {
    formFill: null,
    annotationUpdate: {
      page: 1,
      annotationIndex: 7,
      fingerprint: annotationFingerprint,
      subtype: 'freeText',
      contents: 'Updated note',
      rect: { x: 40, y: 45, width: 170, height: 70 },
    },
    annotationRemove: null,
  });
  assert.deepEqual(buildPdfKitTargetedMutation('annotation-remove', state), {
    formFill: null,
    annotationUpdate: null,
    annotationRemove: {
      page: 1, annotationIndex: 7, fingerprint: annotationFingerprint, subtype: 'freeText',
    },
  });
});

test('targeted builder rejects stale inventory locators and invalid checkbox values', () => {
  assert.throws(
    () => buildPdfKitTargetedMutation('form-fill', workflowState({ pdfkitWidgetIndex: '99' })),
    { message: 'Choose a supported source-bound text, choice, checkbox, or radio field.' },
  );
  assert.throws(
    () => buildPdfKitTargetedMutation('form-fill', workflowState({
      pdfkitWidgetIndex: '4', pdfkitButtonState: 'mixed',
    })),
    { message: 'Choose whether the checkbox should be on or off.' },
  );
  assert.throws(
    () => buildPdfKitTargetedMutation('annotation-update', workflowState({
      pdfkitExistingAnnotationIndex: '99',
    })),
    { message: 'Choose a supported source-bound inert annotation.' },
  );
});

test('local link, outline, line, and ink builders return bounded source-page requests', () => {
  const state = workflowState();
  assert.deepEqual(buildPdfKitLocalGoToMutation(state), {
    link: { sourcePage: 1, targetPage: 2, rect: { x: 30, y: 40, width: 140, height: 24 } },
  });
  assert.deepEqual(buildPdfKitLocalGoToRemovalMutation(state), {
    linkRemoval: { page: 1, annotationIndex: 0, fingerprint: linkFingerprint },
  });
  assert.deepEqual(buildPdfKitOutlineMutation(state), {
    bookmark: { page: 2, label: 'Appendix' },
  });
  assert.deepEqual(buildPdfKitOutlineRemovalMutation(state), {
    bookmarkRemoval: { topLevelIndex: 0, fingerprint: outlineFingerprint },
  });
  assert.deepEqual(buildPdfKitOutlineRenameMutation(state), {
    bookmarkRename: {
      topLevelIndex: 0,
      fingerprint: outlineFingerprint,
      label: 'Renamed appendix',
    },
  });
  assert.deepEqual(buildPdfKitLineAnnotationMutation(state), {
    line: {
      page: 1,
      contents: 'Review line',
      start: { x: 40, y: 50 },
      end: { x: 180, y: 210 },
    },
  });
  assert.deepEqual(buildPdfKitInkAnnotationMutation(state), {
    ink: {
      page: 1,
      contents: 'Review ink',
      points: [{ x: 40, y: 50 }, { x: 90, y: 120 }, { x: 180, y: 210 }],
    },
  });
});

test('local geometry builders preserve exact page and path validation failures', () => {
  assert.throws(
    () => buildPdfKitLocalGoToMutation(workflowState({ pdfkitLinkTargetPage: '3' })),
    { message: 'Choose an existing target page for the local link.' },
  );
  for (const overrides of [
    { pdfkitOutlineTargetPage: '3' },
    { pdfkitOutlineLabel: '' },
    { pdfkitOutlineLabel: ' edge' },
    { pdfkitOutlineLabel: 'unsafe\u202E' },
    { pdfkitOutlineLabel: 'e\u0301' },
  ]) {
    assert.throws(() => buildPdfKitOutlineMutation(workflowState(overrides)));
  }
  for (const overrides of [
    { pdfkitOutlineRenameIndex: '1' },
    { pdfkitOutlineRenameLabel: 'Existing appendix' },
    { pdfkitOutlineRenameLabel: ' edge' },
    { pdfkitOutlineRenameLabel: 'e\u0301' },
  ]) assert.throws(() => buildPdfKitOutlineRenameMutation(workflowState(overrides)));
  for (const overrides of [
    { pdfkitOutlineRemovalIndex: '1' },
    { pdfkitInspectionResult: {
      ...workflowState().pdfkitInspectionResult,
      outline: { ...workflowState().pdfkitInspectionResult.outline, truncated: true },
    } },
    { pdfkitInspectionResult: {
      ...workflowState().pdfkitInspectionResult,
      outline: {
        items: [{
          ...workflowState().pdfkitInspectionResult.outline.items[0],
          children: [{ title: 'Nested', page: 2, children: [], removalLocator: null }],
        }],
        truncated: false,
      },
    } },
  ]) {
    assert.throws(() => buildPdfKitOutlineRemovalMutation(workflowState(overrides)), {
      message: 'Choose a fully inspected source-bound top-level leaf bookmark candidate.',
    });
  }
  for (const overrides of [
    { pdfkitLocalLinkRemovalIndex: '7' },
    { pdfkitLocalLinkRemovalIndex: 'not-an-index' },
    { pdfkitInspectionResult: {
      ...workflowState().pdfkitInspectionResult,
      pages: [{ ...workflowState().pdfkitInspectionResult.pages[0], linksTruncated: true }],
    } },
  ]) {
    assert.throws(() => buildPdfKitLocalGoToRemovalMutation(workflowState(overrides)), {
      message: 'Choose a fully inspected source-bound local page link candidate.',
    });
  }
  assert.throws(
    () => buildPdfKitLineAnnotationMutation(workflowState({
      pdfkitLineEnd: { x: 40, y: 50 },
    })),
    { message: 'Line endpoints must be distinct.' },
  );
  assert.throws(
    () => buildPdfKitInkAnnotationMutation(workflowState({
      pdfkitInkPoints: '40,50;40,50',
    })),
    { message: 'Ink geometry must not contain consecutive duplicate points.' },
  );
  assert.throws(
    () => buildPdfKitInkAnnotationMutation(workflowState({
      pdfkitInkPoints: '40,50;900,900',
    })),
    { message: 'Ink point 2 must lie inside the inspected CropBox for page 1.' },
  );
});

test('password protection normalization accepts only the fixed profiles and distinct confirmed secrets', () => {
  for (const permissionsProfile of [
    'accessibility-only', 'copy-accessibility', 'deny-all', 'print-only',
  ]) {
    assert.deepEqual(normalizePdfKitProtection({
      permissionsProfile,
      userPassword: 'open-password',
      userConfirmation: 'open-password',
      ownerPassword: 'owner-password-long',
      ownerConfirmation: 'owner-password-long',
    }), {
      permissionsProfile,
      userPassword: 'open-password',
      ownerPassword: 'owner-password-long',
    });
  }
  assert.throws(() => normalizePdfKitProtection({
    permissionsProfile: 'all',
    userPassword: 'same-password',
    userConfirmation: 'same-password',
    ownerPassword: 'same-password',
    ownerConfirmation: 'same-password',
  }), {
    message: 'Use a matching 12–16 character open password and a distinct matching 12–32 character owner password in printable ASCII with no edge whitespace.',
  });
});

test('protection-removal normalization binds the retained artifact and owner password', () => {
  const protectionResult = {
    kind: 'pdfkit-password-protection',
    artifact: {
      id: '123e4567-e89b-42d3-a456-426614174000',
      sha256: artifactSha256,
    },
  };
  assert.deepEqual(normalizePdfKitProtectionRemoval(protectionResult, {
    ownerPassword: 'owner-password-long', ownerConfirmation: 'owner-password-long',
  }), {
    artifactId: '123e4567-e89b-42d3-a456-426614174000',
    artifactSha256,
    ownerPassword: 'owner-password-long',
  });
  assert.throws(() => normalizePdfKitProtectionRemoval(
    { ...protectionResult, artifact: { ...protectionResult.artifact, sha256: 'bad' } },
    { ownerPassword: 'owner-password-long', ownerConfirmation: 'owner-password-long' },
  ), {
    message: 'Use the matching 12–32 character owner password for the retained protected copy, in printable ASCII with no edge whitespace.',
  });
});
