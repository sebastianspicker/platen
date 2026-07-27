import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

function analysis() {
  return {
    status: 'ready', documentId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    inspection: {
      pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no',
    },
    structure: {
      xmpMetadata: { present: false }, urls: [], pageBoxes: [],
      namedDestinations: { items: [], truncated: false },
    },
    attachments: [], signatures: { status: 'unsigned', signatureCount: 0 },
    textPages: [], thumbnails: [], fonts: [], images: [],
  };
}

function state() {
  return viewState({
    document: {
      isOpen: true, name: 'source.pdf', size: 4_096,
      type: 'application/pdf', objectUrl: 'blob:source', modified: false,
    },
    host: { status: 'ready', incrementalNamedDestinationReady: true, engines: [] },
    analysis: analysis(),
    incrementalNamedDestinationName: 'chapter-one',
    incrementalNamedDestinationTargetPage: '2',
  });
}

test('named-destination controller runs one fixed source-bound artifact operation', async () => {
  const current = state();
  const calls = [];
  const confirmations = [];
  const operation = {
    documentId: current.analysis.documentId,
    controller: new AbortController(),
  };
  const controller = createPdfKitWorkflowController({
    state: current,
    client: {
      async runIncrementalNamedDestination(...args) {
        calls.push(args);
        return {
          kind: 'pdf-incremental-named-destination',
          artifact: { displayName: 'named.pdf' },
        };
      },
    },
    captureOperation: () => operation, operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { current.busyAction = null; },
    render() {}, announce() {}, showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runIncrementalNamedDestination();
  assert.equal(calls[0][0], current.analysis.documentId);
  assert.equal(calls[0][1], current.analysis.sha256);
  assert.deepEqual(calls[0][2], { targetPage: 2, name: 'chapter-one' });
  assert(calls[0][3].signal instanceof AbortSignal);
  assert.match(confirmations[0], /not general destination management/i);
  assert.equal(
    current.incrementalNamedDestinationResult?.kind,
    'pdf-incremental-named-destination',
  );
});

test('named-destination UI requires empty destination evidence and exact input grammar', () => {
  const eligible = state();
  const readiness = deriveEditorReadiness(eligible, eligible.analysis);
  assert.equal(readiness.incrementalNamedDestinationReady, true);
  const html = editorView(eligible);
  assert.match(html, /data-action="create-incremental-named-destination-copy" >/);
  assert.match(html, /coarse candidate gate/i);
  assert.match(html, /not general destination management/i);

  const existing = state();
  existing.analysis.structure.namedDestinations.items = [
    { page: 1, name: 'existing', destination: '[ Fit ]' },
  ];
  assert.equal(
    deriveEditorReadiness(existing, existing.analysis).incrementalNamedDestinationReady,
    false,
  );
  const invalid = state();
  invalid.incrementalNamedDestinationName = '!unsafe';
  assert.equal(
    deriveEditorReadiness(invalid, invalid.analysis).incrementalNamedDestinationReady,
    false,
  );
  const signed = state();
  signed.analysis.signatures = { status: 'signed', signatureCount: 1 };
  assert.equal(
    deriveEditorReadiness(signed, signed.analysis).incrementalNamedDestinationReady,
    false,
  );
});
