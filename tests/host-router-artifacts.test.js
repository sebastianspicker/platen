import test from 'node:test';
import {
  ACCESSIBILITY_REMEDIATION_MEDIA_TYPE,
  assert,
  createHash,
  createOperationProvenance,
  fixture,
  invoke,
  join,
  makeTextPdf,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  PROJECT_BUNDLE_MEDIA_TYPE,
  Readable,
  writeFile,
} from './support/host-router-fixture.js';
test('cleartext protection-removal artifacts are consumed after transfer and can be explicitly deleted', { timeout: 2_000 }, async (context) => {
  const { handler, store } = await fixture(context);
  const bytes = makeTextPdf('EPHEMERAL CLEARTEXT');
  const document = await store.createDocument({
    stream: Readable.from([bytes]), displayName: 'source.pdf',
  });
  const workspace = await store.createJobWorkspace(document.id);
  const output = join(workspace, 'cleartext.pdf');
  await writeFile(output, bytes, { mode: 0o600 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const provenance = (type) => createOperationProvenance({
    type,
    inputs: [{ documentId: document.id, sha256: document.sha256, role: 'source' }],
    parameters: {}, expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });
  const ephemeral = await store.promotePdfArtifact(document.id, output, {
    displayName: 'cleartext.pdf',
    operation: provenance('pdfkit-protection-removal'),
    expectedSha256: digest,
  });
  const originalClaimArtifact = store.claimArtifactForTransfer.bind(store);
  let resolveConsumed;
  const consumedPromise = new Promise((resolve) => { resolveConsumed = resolve; });
  store.claimArtifactForTransfer = (artifactId) => {
    const claim = originalClaimArtifact(artifactId);
    return Object.freeze({
      artifact: claim.artifact,
      cleanup: async () => {
        await claim.cleanup();
        if (artifactId === ephemeral.id) resolveConsumed();
      },
    });
  };
  const auth = { 'x-platen-token': 'test-session-token' };
  const transfers = await Promise.all([
    invoke(handler, { url: `/api/artifacts/${ephemeral.id}`, headers: auth }),
    invoke(handler, { url: `/api/artifacts/${ephemeral.id}`, headers: auth }),
  ]);
  const downloaded = transfers.find(({ statusCode }) => statusCode === 200);
  const rejected = transfers.find(({ statusCode }) => statusCode === 404);
  assert(downloaded);
  assert(rejected);
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.body, bytes);
  assert.equal(JSON.parse(rejected.body).error.code, 'ARTIFACT_NOT_FOUND');
  await consumedPromise;
  assert.throws(() => store.getArtifact(ephemeral.id), { code: 'ARTIFACT_NOT_FOUND' });

  const deletable = await store.promotePdfArtifact(document.id, output, {
    displayName: 'temporary.pdf',
    operation: provenance('test-rewrite'),
    expectedSha256: digest,
  });
  const deleted = await invoke(handler, {
    method: 'DELETE', url: `/api/artifacts/${deletable.id}`,
    headers: { ...auth, origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(deleted.statusCode, 204);
  assert.throws(() => store.getArtifact(deletable.id), { code: 'ARTIFACT_NOT_FOUND' });
});
