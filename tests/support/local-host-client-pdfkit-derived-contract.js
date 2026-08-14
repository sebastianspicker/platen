import test from 'node:test';
import { assert } from './local-host-client-fixture.js';
import {
  createPdfKitClientSession,
  expectPdfKitClientRequest,
  sourceSha256,
} from './local-host-client-pdfkit-fixture.js';

const mutation = {
  metadata: { title: 'Derived', author: null, subject: null, keywords: null },
  pageBox: null, rotation: null, annotations: [],
};

test('local host client sends only strict bounded general PDFKit mutations', async () => {
  const session = await createPdfKitClientSession();
  const result = await expectPdfKitClientRequest(
    session, 'runPdfKitMutation', 'macos-pdfkit-derived-v1', mutation,
  );
  assert.equal(result.kind, 'pdfkit-structure-mutation');
  assert.equal(result.artifact.documentId, 'doc');
  assert.throws(() => session.client.runPdfKitMutation(
    'doc', 'B'.repeat(64), mutation,
  ), TypeError);
  assert.throws(() => session.client.runPdfKitMutation(
    'doc', sourceSha256, { ...mutation, path: '/tmp/evil' },
  ), TypeError);
  assert.throws(() => session.client.runPdfKitMutation(
    'doc', sourceSha256, { metadata: null, pageBox: null, annotations: [] },
  ), TypeError);
  assert.throws(() => session.client.runPdfKitMutation('doc', sourceSha256, {
    ...mutation,
    annotations: [{
      page: 1, subtype: 'freeText', contents: 'x',
      rect: { x: 0, y: 0, width: 1, height: 1 }, flags: 4,
    }],
  }), TypeError);
  assert.throws(() => session.client.runPdfKitMutation(
    'doc', sourceSha256, mutation, { signal: {}, path: '/tmp/evil' },
  ), TypeError);
});

test('local host client bounds sticky notes and persistent page rotations', async () => {
  const session = await createPdfKitClientSession();
  const stickyNote = {
    metadata: null, pageBox: null, rotation: null,
    annotations: [{
      page: 1, subtype: 'text', contents: 'Private sticky note',
      rect: { x: 10, y: 10, width: 40, height: 40 },
    }],
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitMutation', 'macos-pdfkit-derived-v1', stickyNote,
  );
  assert.throws(() => session.client.runPdfKitMutation('doc', sourceSha256, {
    ...stickyNote,
    annotations: [{ ...stickyNote.annotations[0], subtype: 'stamp' }],
  }), TypeError);

  const rotationMutation = {
    metadata: null, pageBox: null, rotation: { page: 2, degrees: 90 }, annotations: [],
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitMutation', 'macos-pdfkit-derived-v1', rotationMutation,
  );
  for (const rotation of [
    { page: 0, degrees: 90 }, { page: 1, degrees: 45 },
    { page: 1, degrees: 90.5 }, { page: 1, degrees: 90, extra: true },
  ]) {
    assert.throws(() => session.client.runPdfKitMutation('doc', sourceSha256, {
      ...rotationMutation, rotation,
    }), TypeError);
  }
});
