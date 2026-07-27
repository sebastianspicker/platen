import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';

test('workflow controller sends shared metadata through the append-only artifact path', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const state = {
    analysis: { documentId: 'document-1', sha256: sourceSha256 },
    host: { incrementalMetadataReady: true },
    busyAction: null,
    pdfkitMetadata: { title: 'Object safe', author: '', subject: 'Local', keywords: '' },
  };
  const calls = [];
  const confirmations = [];
  const operation = { documentId: 'document-1', controller: new AbortController() };
  const controller = createPdfKitWorkflowController({
    state,
    client: {
      async runIncrementalMetadata(documentId, digest, metadata, options) {
        calls.push({ documentId, digest, metadata, options });
        return {
          kind: 'pdf-incremental-metadata',
          artifact: { displayName: 'object-safe.pdf' },
        };
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { state.busyAction = null; },
    render() {},
    announce() {},
    showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runIncrementalMetadata();
  assert.deepEqual(calls[0].metadata, {
    title: 'Object safe', author: null, subject: 'Local', keywords: null,
  });
  assert.equal(calls[0].documentId, 'document-1');
  assert.equal(calls[0].digest, sourceSha256);
  assert(calls[0].options.signal instanceof AbortSignal);
  assert.match(confirmations[0], /prior metadata remains recoverable/);
  assert.equal(state.incrementalMetadataResult?.kind, 'pdf-incremental-metadata');
});
