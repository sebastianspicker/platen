import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessibilityAltTextOperations } from '../src/controllers/review/accessibility-alt-text-operations.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';

test('alt-text proposal disables editing and suppresses export after authoring state changes', async () => {
  const locator = 'b'.repeat(64);
  const state = {
    analysis: {
      status: 'ready', documentId: 'document-1', sha256: 'a'.repeat(64),
      inspection: { pageCount: 1 }, signatures: { status: 'unsigned', signatureCount: 0 },
    },
    document: { name: 'source.pdf' },
    host: { accessibilityRemediationReady: true, engines: [] },
    busyAction: null, error: null, domainRevision: 0,
    accessibilityAltTextCandidateLocator: locator,
    accessibilityAltText: 'Original description',
    accessibilityAltTextProposalResult: null,
    accessibilityReviewResult: {
      kind: 'accessibility-review', sourceDigest: 'a'.repeat(64), reportSha256: 'c'.repeat(64),
      remediationPlan: {
        truncated: false,
        candidates: [{
          action: 'author-image-alt-text', status: 'proposed-not-applied',
          target: { page: 1, imageNumber: 0, locator },
        }],
      },
    },
  };
  let resolveCreate; let exports = 0; let downloads = 0;
  const createPending = new Promise((resolve) => { resolveCreate = resolve; });
  const operations = createAccessibilityAltTextOperations({
    state,
    client: {
      createAccessibilityProposal: async () => createPending,
      exportAccessibilityProposal: async () => { exports += 1; return '{}'; },
    },
    BlobConstructor: Blob,
    captureOperation: () => ({ documentId: 'document-1', controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { state.busyAction = null; },
    triggerDownload: () => { downloads += 1; },
    render: () => {},
  });
  const pending = operations.createAccessibilityAltTextProposal();
  assert.equal(deriveEditorReadiness(state, state.analysis).accessibilityAltTextEditorReady, false);
  state.accessibilityAltText = 'Changed while pending';
  resolveCreate({ proposalId: 'proposal-1', revision: 1 });
  await pending;
  assert.equal(state.domainRevision, 1, 'the committed workspace revision remains synchronized');
  assert.equal(exports, 0);
  assert.equal(downloads, 0);
  assert.equal(state.accessibilityAltTextProposalResult, null);
});
