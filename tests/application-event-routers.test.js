import assert from 'node:assert/strict';
import test from 'node:test';
import { bindApplicationClickEvents } from '../src/ui/application-click-router.js';
import { bindApplicationFormEvents } from '../src/ui/application-form-router.js';

function eventRoot() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
}

function controllerSet(overrides = {}) {
  return {
    viewer: {},
    lifecycle: {},
    generation: {},
    domain: {},
    aec: {},
    pageComposition: {},
    comparison: {},
    ocr: {},
    raster: {},
    review: {},
    pdfkit: {},
    pluginPlatform: {},
    documentOperations: {},
    ...overrides,
  };
}

function assertAccessibilityAltTextBindings({ root, state, input }) {
  input({
    target: {
      value: 'Human-authored description', selectionStart: 26,
      matches: (selector) => selector === '#accessibility-alt-text',
    },
  });
  assert.equal(state.accessibilityAltText, 'Human-authored description');
  assert.equal(state.accessibilityAltTextProposalResult, null);
  state.accessibilityAltTextProposalResult = { previous: true };
  root.listeners.get('change')({
    target: {
      value: 'b'.repeat(64),
      matches: (selector) => selector === '#accessibility-alt-text-candidate',
    },
  });
  assert.equal(state.accessibilityAltTextCandidateLocator, 'b'.repeat(64));
  assert.equal(state.accessibilityAltTextProposalResult, null);
}

test('application click router owns delegated selection and command dispatch', async () => {
  const root = eventRoot();
  const calls = [];
  const state = {
    selectedPlugin: '',
    familyFilter: 'all',
    zoom: 1,
    rotation: 0,
    analysis: { inspection: { pageCount: 3 } },
  };
  const controllers = controllerSet({
    viewer: { selectPage: (page) => calls.push(['page', page]) },
    generation: { rewriteLocalDocument: (mode) => calls.push(['rewrite', mode]) },
    pluginPlatform: { inspectSandbox: () => calls.push(['sandbox-probe']) },
  });
  const unbind = bindApplicationClickEvents({
    root,
    state,
    controllers,
    document: { querySelector: () => null },
    window: { print() {} },
    render: () => calls.push(['render']),
    announce: () => {},
    showError: () => {},
    downloadOriginal: () => {},
    exportText: () => {},
    exportStructuredText: () => {},
  });
  const click = root.listeners.get('click');
  await click({
    target: {
      closest(selector) {
        return selector === '[data-plugin-row]' ? { dataset: { pluginRow: 'ocr' } } : null;
      },
    },
  });
  assert.equal(state.selectedPlugin, 'ocr');

  await click({
    target: {
      closest(selector) {
        return selector === '[data-rewrite-mode]'
          ? { dataset: { rewriteMode: 'optimize' } }
          : null;
      },
    },
  });
  assert.deepEqual(calls.find(([name]) => name === 'rewrite'), ['rewrite', 'optimize']);

  await click({
    target: {
      closest(selector) {
        return selector === '[data-action]'
          ? { dataset: { action: 'run-sandbox-probe' } }
          : null;
      },
    },
  });
  assert.deepEqual(calls.find(([name]) => name === 'sandbox-probe'), ['sandbox-probe']);
  unbind();
  assert.equal(root.listeners.has('click'), false);
});

test('application form router owns state bindings and invalidates derived PDFKit state', () => {
  const root = eventRoot();
  const calls = [];
  const state = {
    pdfkitMetadata: { title: '' },
    incrementalBleedBoxResult: { previous: true },
    incrementalMetadataResult: { previous: true },
    incrementalAccessibilityMetadataResult: { previous: true },
    accessibilityDocumentLanguage: '',
    accessibilityDocumentTitle: '',
    accessibilityAltTextCandidateLocator: '',
    accessibilityAltText: '',
    accessibilityAltTextProposalResult: { previous: true },
    pdfkitMutationResult: { previous: true },
    cropRegion: { x: 0 },
    redactRegion: {},
    snapshotRegion: {},
    pdfkitPageBoxRect: {},
    pdfkitAnnotationRect: {},
    pdfkitLinkRect: {},
    pdfkitLineStart: {},
    pdfkitLineEnd: {},
    pdfkitExistingAnnotationRect: {},
    pdfkitOutlineLabel: '',
    pdfkitOutlineTargetPage: '1',
    pdfkitOutlineRenameLabel: '',
    pdfkitOutlineRenameIndex: '',
    pdfkitLocalLinkRemovalIndex: '',
    ocrResult: { suspects: [{}] },
    ocrSuspectReviewStates: ['unreviewed'],
    selectedPage: 1,
    pdfkitInspectionResult: {
      pages: [{
        index: 1,
        boxes: { bleed: { x: 10, y: 10, width: 592, height: 772 } },
      }],
    },
  };
  const controllers = controllerSet({
    viewer: { updateSearchResults: () => calls.push('search'), resetLoupe() {} },
    ocr: {
      updateSelectedOcrZone() {}, clearOcrLayoutSelection() {}, setOcrBatchFiles() {},
      setOcrSuspectReviewState: (index, reviewState) => calls.push(['ocr-review', index, reviewState]),
    },
  });
  bindApplicationFormEvents({
    root,
    state,
    controllers,
    document: { querySelector: () => null },
    render: () => calls.push('render'),
  });
  const input = root.listeners.get('input');
  input({ target: { value: 'Local title', matches: (selector) => selector === '#pdfkit-title' } });
  assert.equal(state.pdfkitMetadata.title, 'Local title');
  assert.equal(state.incrementalMetadataResult, null);
  assert.equal(state.pdfkitMutationResult, null);

  const rendersBeforeAccessibilityInput = calls.filter((entry) => entry === 'render').length;
  input({
    target: {
      value: 'en-us',
      matches: (selector) => selector === '#accessibility-document-language',
    },
  });
  assert.equal(state.accessibilityDocumentLanguage, 'en-us');
  assert.equal(state.incrementalAccessibilityMetadataResult, null);
  assert.equal(
    calls.filter((entry) => entry === 'render').length,
    rendersBeforeAccessibilityInput + 1,
  );
  assertAccessibilityAltTextBindings({ root, state, input });

  state.pdfkitMutationResult = { previous: true };
  input({ target: { value: 'Renamed', matches: (selector) => selector === '#pdfkit-outline-rename-label' } });
  assert.equal(state.pdfkitOutlineRenameLabel, 'Renamed');
  assert.equal(state.pdfkitMutationResult, null);

  input({ target: { value: '0.25', matches: (selector) => selector === '#crop-x' } });
  assert.equal(state.cropRegion.x, '0.25');

  state.pdfkitMutationResult = { previous: true };
  input({ target: { value: 'Appendix', matches: (selector) => selector === '#pdfkit-outline-label' } });
  assert.equal(state.pdfkitOutlineLabel, 'Appendix');
  assert.equal(state.pdfkitMutationResult, null);

  const change = root.listeners.get('change');
  state.pdfkitMutationResult = { previous: true };
  change({ target: { value: '1', matches: (selector) => selector === '#pdfkit-outline-rename-index' } });
  assert.equal(state.pdfkitOutlineRenameIndex, '1');
  assert.equal(state.pdfkitMutationResult, null);

  state.pdfkitMutationResult = { previous: true };
  change({ target: { value: '2', matches: (selector) => selector === '#pdfkit-outline-target-page' } });
  assert.equal(state.pdfkitOutlineTargetPage, '2');
  assert.equal(state.pdfkitMutationResult, null);

  state.pdfkitMutationResult = { previous: true };
  change({ target: { value: '4', matches: (selector) => selector === '#pdfkit-local-link-removal-index' } });
  assert.equal(state.pdfkitLocalLinkRemovalIndex, '4');
  assert.equal(state.pdfkitMutationResult, null);

  state.pdfkitMutationResult = { previous: true };
  state.incrementalBleedBoxResult = { previous: true };
  change({ target: { value: 'bleed', matches: (selector) => selector === '#pdfkit-page-box' } });
  assert.equal(state.pdfkitPageBox, 'bleed');
  assert.deepEqual(state.pdfkitPageBoxRect, { x: 10, y: 10, width: 592, height: 772 });
  assert.equal(state.pdfkitMutationResult, null);
  assert.equal(state.incrementalBleedBoxResult, null);

  change({
    target: {
      value: 'false-positive', dataset: { ocrSuspectIndex: '0' },
      matches: (selector) => selector === '.ocr-suspect-review-state',
    },
  });
  assert.deepEqual(calls.find((entry) => Array.isArray(entry) && entry[0] === 'ocr-review'), [
    'ocr-review', 0, 'false-positive',
  ]);
});
