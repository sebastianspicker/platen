import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PAGE_TEXT_CLIPBOARD_UNITS } from '../src/core/page-text-clipboard.js';
import { MAX_READ_ALOUD_CHARACTERS } from '../src/core/read-aloud.js';
import { createViewerOutputController } from '../src/controllers/viewer/output-controller.js';

const READY_DOCUMENT_ID = 'document-1';
const READY_SHA256 = 'a'.repeat(64);

function createHarness({
  analysis = {},
  selectedPage = 1,
  busyAction = null,
  documentLang = 'en',
  windowSpeech = true,
  writeText,
  navigatorClipboard,
  operationIsCurrent = () => true,
  captureOperation = () => ({ documentId: READY_DOCUMENT_ID, controller: new AbortController() }),
  selectionTrackerGeneration = 0,
} = {}) {
  const state = {
    selectedPage,
    busyAction,
    analysis: {
      status: 'ready',
      documentId: READY_DOCUMENT_ID,
      sha256: READY_SHA256,
      textPages: [],
      ...analysis,
    },
  };

  const clipboardWrites = [];
  const writeTextToClipboard = writeText ?? (async (text) => clipboardWrites.push(text));
  const navigatorToUse = navigatorClipboard ?? { writeText: writeTextToClipboard };
  const announcements = [];
  const errors = [];
  const renders = [];
  const reportOperationErrors = [];
  const spoken = [];
  const speechApi = windowSpeech
    ? {
      cancel: () => spoken.push({ type: 'cancel' }),
      speak: (utterance) => spoken.push({ type: 'speak', utterance }),
    }
    : null;
  const utterances = [];
  const SelectionUtterance = class {
    constructor(text) {
      this.text = text;
      this.lang = '';
      utterances.push(this);
    }
  };

  const selectionTracker = {
    generation: selectionTrackerGeneration,
  };
  const controller = createViewerOutputController({
    state,
    client: {},
    selectionTracker,
    decodeControlledRaster: () => {},
    captureOperation,
    operationIsCurrent,
    reportOperationError: (error) => reportOperationErrors.push(error),
    finishOperation: () => {},
    triggerDownload: () => {},
    render: () => renders.push('render'),
    announce: (message) => announcements.push(message),
    showError: (error) => errors.push(error.message),
    documentApi: {
      documentElement: { lang: documentLang },
    },
    windowApi: {
      speechSynthesis: speechApi,
      SpeechSynthesisUtterance: SelectionUtterance,
    },
    navigatorApi: {
      clipboard: navigatorToUse,
    },
  });

  return {
    state,
    controller,
    clipboardWrites,
    announcements,
    errors,
    renders,
    reportOperationErrors,
    spoken,
    utterances,
  };
}

test('viewer.read-aloud enforces ready source-bound analysis and speech API gate', () => {
  const baseAnalysis = {
    textPages: [{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }],
  };
  const invalidStates = [
    { status: 'pending' },
    { documentId: '' },
    { sha256: 'A'.repeat(64) },
  ];

  for (const overrides of invalidStates) {
    const harness = createHarness({ analysis: { ...baseAnalysis, ...overrides } });
    harness.controller.readSelectedPage();
    assert.equal(harness.errors.at(-1), 'Read aloud is unavailable until the current document analysis is ready.');
    assert.equal(harness.spoken.length, 0);
  }
});

test('viewer.read-aloud is blocked when local speech APIs are unavailable', () => {
  const harness = createHarness({
    analysis: { textPages: [{ page: 1, text: 'alpha' }] },
    windowSpeech: false,
    navigatorClipboard: { writeText: async () => {} },
  });
  harness.controller.readSelectedPage();
  assert.equal(harness.errors.at(-1), 'Read aloud is unavailable for this page in the current browser.');
  assert.equal(harness.spoken.length, 0);
});

test('viewer.read-aloud cancels prior speech, speaks bounded selected-page text, and uses document language', () => {
  const harness = createHarness({
    analysis: {
      textPages: [
        { page: 1, text: ' alpha ' },
        { page: 2, text: `${'x'.repeat(MAX_READ_ALOUD_CHARACTERS + 10)}` },
      ],
    },
    selectedPage: 2,
    documentLang: 'de',
  });

  harness.controller.readSelectedPage();
  const spoken = harness.spoken.filter(({ type }) => type === 'speak');
  const canceled = harness.spoken.filter(({ type }) => type === 'cancel');
  assert.equal(spoken.length, 1);
  assert.equal(canceled.length, 1);
  assert.equal(utteranceText(spoken.at(0).utterance), 'x'.repeat(MAX_READ_ALOUD_CHARACTERS));
  assert.equal(spoken.at(0).utterance.lang, 'de');
  assert.equal(harness.announcements.at(-1), 'Reading page 2 aloud with the local browser voice.');
  assert.equal(harness.announcements.length, 1);

  harness.controller.readSelectedPage();
  assert.equal(harness.spoken.filter(({ type }) => type === 'cancel').length, 2);
  assert.equal(harness.spoken.filter(({ type }) => type === 'speak').length, 2);
});

function utteranceText(utterance) {
  return utterance?.text;
}

test('viewer.copy-selected-page requires ready source-bound analysis state', async () => {
  const invalidStates = [
    { status: 'pending' },
    { documentId: 'document-2', sha256: 'A'.repeat(64) },
  ];
  for (const overrides of invalidStates) {
    const harness = createHarness({ analysis: { ...overrides, textPages: [{ page: 1, text: 'alpha' }] } });
    await harness.controller.copySelectedPageText();
    assert.equal(harness.clipboardWrites.length, 0);
    assert.equal(harness.errors.at(-1), 'Page text copy is unavailable until the current analysis is ready.');
  }
});

test('viewer.copy-selected-page writes only exact trimmed current-page extracted text', async () => {
  const harness = createHarness({
    analysis: {
      textPages: [
        { page: 1, text: '  exact\npage text  ' },
        { page: 2, text: 'other' },
      ],
    },
    selectedPage: 1,
  });
  await harness.controller.copySelectedPageText();
  assert.equal(harness.clipboardWrites.length, 1);
  assert.equal(harness.clipboardWrites[0], 'exact\npage text');
  assert.equal(harness.announcements.at(-1), 'Text from page 1 copied to the clipboard.');
});

test('viewer.copy-selected-page enforces clipboard-bound and stale completion suppression', async () => {
  const harness = createHarness({
    analysis: {
      textPages: [{ page: 1, text: 'first-page' }],
    },
  });
  const completion = harness.controller.copySelectedPageText();
  harness.state.selectedPage = 2;
  await completion;
  assert.equal(harness.clipboardWrites.length, 1);
  assert.equal(harness.announcements.length, 0);
});

test('viewer.copy-selected-page blocks stale document completion', async () => {
  const copyWrites = [];
  const pendingWrites = [];
  const completionPromise = new Promise((resolve) => pendingWrites.push(resolve));
  const harness = createHarness({
    analysis: {
      textPages: [{ page: 1, text: 'first-page' }],
    },
    writeText: async (text) => {
      copyWrites.push(text);
      return completionPromise;
    },
  });
  const completion = harness.controller.copySelectedPageText();
  harness.state.analysis.sha256 = 'b'.repeat(64);
  pendingWrites.at(0)();
  await completion;
  assert.equal(copyWrites.length, 1);
  assert.equal(harness.announcements.length, 0);
});

test('viewer.copy-selected-page rejects a captured operation for another document before writing', async () => {
  const harness = createHarness({
    analysis: {
      textPages: [{ page: 1, text: 'first-page' }],
    },
    captureOperation: () => ({
      documentId: 'another-document',
      controller: new AbortController(),
    }),
  });
  await harness.controller.copySelectedPageText();
  assert.equal(harness.clipboardWrites.length, 0);
  assert.equal(harness.announcements.length, 0);
});

test('viewer read and copy remain inert while another viewer action is busy', async () => {
  const harness = createHarness({
    analysis: {
      textPages: [{ page: 1, text: 'first-page' }],
    },
    busyAction: 'Rendering a page',
  });
  harness.controller.readSelectedPage();
  await harness.controller.copySelectedPageText();
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.clipboardWrites.length, 0);
  assert.equal(harness.errors.length, 0);
});

test('viewer.copy-selected-page limits to 20_000', async () => {
  const harness = createHarness({
    analysis: {
      textPages: [{ page: 1, text: 'x'.repeat(MAX_PAGE_TEXT_CLIPBOARD_UNITS + 1) }],
    },
  });
  await harness.controller.copySelectedPageText();
  assert.equal(harness.clipboardWrites.length, 0);
  assert.equal(harness.errors.at(-1), 'No bounded extracted text is available for the selected page.');
});

test('viewer.copy-selected-page fails visibly when clipboard support is unavailable', async () => {
  const harness = createHarness({
    analysis: {
      textPages: [{ page: 1, text: 'alpha' }],
    },
    navigatorClipboard: {},
  });
  await harness.controller.copySelectedPageText();
  assert.equal(harness.errors.at(-1), 'Text clipboard writing is unavailable in this browser.');
});
