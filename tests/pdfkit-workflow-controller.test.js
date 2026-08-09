import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';

function fixture(overrides = {}) {
  const state = {
    analysis: { documentId: 'document-1', sha256: 'a'.repeat(64) },
    document: { name: 'source.pdf' },
    host: { pdfkitInspectionReady: true, pdfkitSanitizationReady: true },
    busyAction: null,
    selectedPage: 1,
    ...overrides,
  };
  const calls = {
    renders: 0, announcements: [], downloads: [], sanitizations: [], outlineMutations: [],
    localGoToRemovals: [], outlineRemovals: [], outlineRenames: [],
    targetedMutations: [],
  };
  const operation = { documentId: 'document-1', controller: new AbortController() };
  const controller = createPdfKitWorkflowController({
    state,
    client: {
      async runPdfKitInspection() {
        return {
          kind: 'pdfkit-structure-inspection', sourceDigest: state.analysis.sha256, pageCount: 2,
          metadata: { title: 'Inventory title' },
          pages: [{
            index: 1, rotation: 0,
            boxes: { crop: { x: 10, y: 20, width: 500, height: 700 }, media: { x: 0, y: 0, width: 612, height: 792 } },
            widgets: [{ annotationIndex: 4, fieldType: 'text' }],
            annotations: [
              { annotationIndex: 0, subtype: 'link', fingerprint: 'b'.repeat(64) },
              { annotationIndex: 6, subtype: 'freeText' },
            ],
            annotationsTruncated: false,
            links: [{ annotationIndex: 0, kind: 'goTo', targetPage: 2 }],
            linksTruncated: false,
          }],
          outline: {
            items: [{
              title: 'Existing', page: 1, children: [],
              removalLocator: { topLevelIndex: 0, fingerprint: 'c'.repeat(64) },
            }],
            truncated: false,
          },
        };
      },
      async sanitizePdfKitMetadata(documentId, sourceSha256, options) {
        calls.sanitizations.push({ documentId, sourceSha256, options });
        return { artifact: { displayName: 'sanitized.pdf' } };
      },
      async runPdfKitOutlineMutation(documentId, sourceSha256, mutation, options) {
        calls.outlineMutations.push({ documentId, sourceSha256, mutation, options });
        return { artifact: { displayName: 'bookmarked.pdf' } };
      },
      async runPdfKitOutlineRemovalMutation(documentId, sourceSha256, mutation, options) {
        calls.outlineRemovals.push({ documentId, sourceSha256, mutation, options });
        return { artifact: { displayName: 'bookmark-removed.pdf' } };
      },
      async runPdfKitOutlineRenameMutation(documentId, sourceSha256, mutation, options) {
        calls.outlineRenames.push({ documentId, sourceSha256, mutation, options });
        return { artifact: { displayName: 'bookmark-renamed.pdf' } };
      },
      async runPdfKitLocalGoToRemovalMutation(documentId, sourceSha256, mutation, options) {
        calls.localGoToRemovals.push({ documentId, sourceSha256, mutation, options });
        return { artifact: { displayName: 'link-removed.pdf' } };
      },
      async runPdfKitTargetedMutation(documentId, sourceSha256, mutation, options) {
        calls.targetedMutations.push({ documentId, sourceSha256, mutation, options });
        return { artifact: { displayName: 'square-properties.pdf' } };
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { state.busyAction = null; },
    render: () => { calls.renders += 1; },
    announce: (message) => calls.announcements.push(message),
    showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: () => true,
    triggerDownload: (download) => calls.downloads.push(download),
  });
  return { controller, state, calls };
}

test('PDFKit controller preserves inspection defaults, JSON export, and sanitization transport shape', async () => {
  const { controller, state, calls } = fixture();

  await controller.runPdfKitInspection();

  assert.equal(state.pdfkitMetadata.title, 'Inventory title');
  assert.equal(state.pdfkitMetadata.author, '');
  assert.equal(state.pdfkitWidgetIndex, '4');
  assert.equal(state.pdfkitExistingAnnotationIndex, '6');
  assert.equal(state.pdfkitPageRotation, '90');
  assert.deepEqual(state.pdfkitPageBoxRect, { x: 10, y: 20, width: 500, height: 700 });
  assert.equal(state.pdfkitLinkTargetPage, '2');
  assert.equal(state.pdfkitOutlineTargetPage, '1');
  assert.equal(state.pdfkitLocalLinkRemovalIndex, '0');
  assert.equal(state.pdfkitOutlineRemovalIndex, '0');
  assert.equal(state.pdfkitOutlineRenameIndex, '0');
  assert.match(calls.announcements.at(-1), /Read-only PDFKit inventory completed for 2 pages/);

  controller.exportPdfKitInspection();
  assert.equal(calls.downloads[0].fileName, 'source-macos-pdfkit-inventory.json');
  assert.equal(calls.downloads[0].blob.type, 'application/json');

  await controller.runPdfKitMetadataSanitization();
  assert.equal(calls.sanitizations.length, 1);
  assert.equal(calls.sanitizations[0].documentId, 'document-1');
  assert.equal(calls.sanitizations[0].sourceSha256, 'a'.repeat(64));
  assert(calls.sanitizations[0].options.signal instanceof AbortSignal);
});

test('PDFKit controller sends one exact Square annotation-property mutation', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const { controller, calls } = fixture({
    host: { pdfkitMutationReady: true },
    pdfkitInspectionResult: {
      sourceDigest: sourceSha256,
      pageCount: 1,
      pages: [{
        index: 1,
        boxes: { media: { x: 0, y: 0, width: 612, height: 792 } },
        annotations: [{ annotationIndex: 6, subtype: 'square', fingerprint: 'b'.repeat(64) }],
      }],
    },
    pdfkitExistingAnnotationIndex: '6',
    pdfkitExistingAnnotationRect: { x: 40, y: 45, width: 170, height: 70 },
    pdfkitExistingAnnotationStrokeColor: '#d32f2f',
  });
  await controller.runPdfKitTargetedMutation('annotation-properties');
  assert.deepEqual(calls.targetedMutations[0].mutation, {
    formFill: null,
    annotationUpdate: null,
    annotationProperties: {
      page: 1, annotationIndex: 6, fingerprint: 'b'.repeat(64), subtype: 'square',
      rect: { x: 40, y: 45, width: 170, height: 70 }, strokeColor: '#d32f2f',
    },
    annotationRemove: null,
  });
});

test('PDFKit controller sends one exact outline bookmark through the artifact pipeline', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const { controller, state, calls } = fixture({
    host: { pdfkitMutationReady: true },
    pdfkitInspectionResult: { sourceDigest: sourceSha256, pageCount: 2 },
    pdfkitOutlineLabel: 'Appendix',
    pdfkitOutlineTargetPage: '2',
  });
  await controller.runPdfKitOutlineMutation();
  assert.equal(calls.outlineMutations.length, 1);
  assert.deepEqual(calls.outlineMutations[0].mutation, {
    bookmark: { page: 2, label: 'Appendix' },
  });
  assert.equal(calls.outlineMutations[0].sourceSha256, sourceSha256);
  assert(calls.outlineMutations[0].options.signal instanceof AbortSignal);
});

test('PDFKit controller removes one exact inspected local link through the artifact pipeline', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const { controller, calls } = fixture({
    host: { pdfkitMutationReady: true },
    pdfkitInspectionResult: {
      sourceDigest: sourceSha256,
      pageCount: 2,
      pages: [{
        index: 1,
        annotations: [{ annotationIndex: 0, subtype: 'link', fingerprint: 'b'.repeat(64) }],
        annotationsTruncated: false,
        links: [{ annotationIndex: 0, kind: 'goTo', targetPage: 2 }],
        linksTruncated: false,
      }],
    },
    pdfkitLocalLinkRemovalIndex: '0',
  });
  await controller.runPdfKitLocalGoToRemovalMutation();
  assert.equal(calls.localGoToRemovals.length, 1);
  assert.deepEqual(calls.localGoToRemovals[0].mutation, {
    linkRemoval: { page: 1, annotationIndex: 0, fingerprint: 'b'.repeat(64) },
  });
  assert.equal(calls.localGoToRemovals[0].sourceSha256, sourceSha256);
  assert(calls.localGoToRemovals[0].options.signal instanceof AbortSignal);
});

test('PDFKit controller removes one exact inspected top-level leaf bookmark', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const { controller, calls } = fixture({
    host: { pdfkitMutationReady: true },
    pdfkitInspectionResult: {
      sourceDigest: sourceSha256,
      pageCount: 2,
      outline: {
        items: [{
          title: 'Existing', page: 2, children: [],
          removalLocator: { topLevelIndex: 0, fingerprint: 'c'.repeat(64) },
        }],
        truncated: false,
      },
    },
    pdfkitOutlineRemovalIndex: '0',
  });
  await controller.runPdfKitOutlineRemovalMutation();
  assert.equal(calls.outlineRemovals.length, 1);
  assert.deepEqual(calls.outlineRemovals[0].mutation, {
    bookmarkRemoval: { topLevelIndex: 0, fingerprint: 'c'.repeat(64) },
  });
  assert.equal(calls.outlineRemovals[0].sourceSha256, sourceSha256);
  assert(calls.outlineRemovals[0].options.signal instanceof AbortSignal);
});

test('PDFKit controller renames one exact inspected top-level leaf bookmark', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const { controller, calls } = fixture({
    host: { pdfkitMutationReady: true },
    pdfkitInspectionResult: {
      sourceDigest: sourceSha256,
      pageCount: 2,
      outline: {
        items: [{
          title: 'Existing', page: 2, children: [],
          removalLocator: { topLevelIndex: 0, fingerprint: 'c'.repeat(64) },
        }],
        truncated: false,
      },
    },
    pdfkitOutlineRenameIndex: '0',
    pdfkitOutlineRenameLabel: 'Renamed bookmark',
  });
  await controller.runPdfKitOutlineRenameMutation();
  assert.equal(calls.outlineRenames.length, 1);
  assert.deepEqual(calls.outlineRenames[0].mutation, {
    bookmarkRename: {
      topLevelIndex: 0,
      fingerprint: 'c'.repeat(64),
      label: 'Renamed bookmark',
    },
  });
  assert.equal(calls.outlineRenames[0].sourceSha256, sourceSha256);
  assert(calls.outlineRenames[0].options.signal instanceof AbortSignal);
});
