import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentOperationCoordinator } from '../src/core/document-operation-coordinator.js';

function setup({ client = {}, generation = 1, documentId = 'document-1' } = {}) {
  const events = [];
  const context = { generation, documentId };
  const coordinator = new DocumentOperationCoordinator({
    getGeneration: () => context.generation,
    getDocumentId: () => context.documentId,
    client,
    onCapture: () => events.push('capture'),
    onFinish: () => events.push('finish'),
    onCancelled: () => events.push('cancelled'),
    onError: (error) => events.push(`error:${error.message}`),
    onCancel: () => events.push('cancel-requested'),
    onDownload: (download) => events.push(download),
  });
  return { context, coordinator, events };
}

const artifact = Object.freeze({ id: 'artifact-1', displayName: 'derived.pdf' });

test('document operation coordinator downloads a current derived artifact and finalizes it', async () => {
  const blob = new Blob(['derived']);
  const { coordinator, events } = setup({
    client: { artifact: async (_id, { signal }) => { assert(signal instanceof AbortSignal); return blob; } },
  });
  const operation = coordinator.capture();

  assert.equal(await coordinator.downloadDerivedArtifact(artifact, operation, 'Derived PDF ready.'), true);
  coordinator.finish(operation);

  assert.deepEqual(events, [
    'capture',
    { blob, fileName: 'derived.pdf', message: 'Derived PDF ready.' },
    'finish',
  ]);
  assert.equal(coordinator.activeController, null);
});

test('document operation coordinator rejects stale generation results without touching a replacement document', async () => {
  const { context, coordinator, events } = setup({
    client: { artifact: async () => new Blob(['stale']) },
  });
  const operation = coordinator.capture();
  context.generation += 1;
  context.documentId = 'document-2';

  assert.equal(await coordinator.downloadDerivedArtifact(artifact, operation, 'Must not announce.'), false);
  coordinator.reportError(new Error('Must not report.'), operation);
  coordinator.finish(operation);

  assert.deepEqual(events, ['capture']);
  assert.equal(coordinator.activeController, operation.controller);
});

test('document operation coordinator reports cancellation only while its operation remains current', () => {
  const { coordinator, events } = setup();
  const operation = coordinator.capture();

  assert.equal(coordinator.cancel(), true);
  coordinator.reportError(new Error('AbortError'), operation);
  coordinator.finish(operation);

  assert.equal(operation.controller.signal.aborted, true);
  assert.deepEqual(events, ['capture', 'cancel-requested', 'cancelled', 'finish']);
  assert.equal(coordinator.activeController, null);
});

test('ephemeral derived artifacts are deleted when retrieval fails and preserve the retrieval failure', async () => {
  const retrievalFailure = new Error('download failed');
  const deletions = [];
  const { coordinator, events } = setup({
    client: {
      artifact: async () => { throw retrievalFailure; },
      deleteArtifact: async (id, options) => deletions.push({ id, options }),
    },
  });
  const operation = coordinator.capture();

  await assert.rejects(
    coordinator.downloadEphemeralDerivedArtifact(artifact, operation, 'Must not announce.'),
    retrievalFailure,
  );

  assert.deepEqual(deletions, [{ id: 'artifact-1', options: { keepalive: true } }]);
  assert.deepEqual(events, ['capture']);
});

test('ephemeral derived artifacts surface cleanup failures after a successful retrieval', async () => {
  const cleanupFailure = new Error('cleanup failed');
  const { coordinator, events } = setup({
    client: {
      artifact: async () => new Blob(['derived']),
      deleteArtifact: async () => { throw cleanupFailure; },
    },
  });
  const operation = coordinator.capture();

  await assert.rejects(
    coordinator.downloadEphemeralDerivedArtifact(artifact, operation, 'Must not announce.'),
    cleanupFailure,
  );
  assert.deepEqual(events, ['capture']);
});
