import test from 'node:test';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { PdfAccessibilityFormSemanticsService } from '../scripts/host/pdf-accessibility-form-semantics-service.mjs';
import { assert, HANDLERS, addDocument, delivery, formRequest, initializedStore } from './support/professional-accessibility-route-client-cli-support.js';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';

test('source-bound facade uses the immutable stored form source and retains the validated production receipt', async (t) => {
  const store = await initializedStore(t, 'facade');
  const sourcePdf = makeButtonWidgetPdf();
  const document = await addDocument(store, sourcePdf);
  const request = formRequest(sourcePdf);
  const professional = delivery(store, {
    accessibilityFormSemantics: new PdfAccessibilityFormSemanticsService({ store }),
  });
  const result = await professional.deliverSourceBound('accessibility.form-semantics', document.id, request);
  assert.equal(result.sourceSha256, document.sha256);
  assert.equal(result.artifact.documentId, document.id);
  assert.equal(result.serviceReceipt.artifact.id, result.artifact.id);
  assert.equal(result.serviceReceipt.proof.sourceSha256, document.sha256);
  assert.equal(result.professionalProof, true);
  assert.deepEqual(result.trustBoundary, {
    productionService: true,
    immutableSourceDigest: true,
    artifactReread: true,
    independentSemanticInspection: true,
  });
  assert.equal(store.getArtifact(result.artifact.id).sha256, result.outputSha256);
  await store.deleteArtifact(result.artifact.id);
});

test('source-bound facade rejects inherited accessibility service keys', async (t) => {
  const store = await initializedStore(t, 'inherited-service');
  const sourcePdf = makeButtonWidgetPdf();
  const document = await addDocument(store, sourcePdf);
  const inheritedServices = Object.create({
    accessibilityFormSemantics: { repair: async () => assert.fail('inherited service must not be invoked') },
  });
  const facadeStore = {
    verifySource: store.verifySource.bind(store),
    getDocument: store.getDocument.bind(store),
    getSourcePath: () => assert.fail('unavailable services must be rejected before source bytes are read'),
  };
  const professional = delivery(facadeStore, inheritedServices);
  await assert.rejects(
    professional.deliverSourceBound('accessibility.form-semantics', document.id, formRequest(sourcePdf)),
    { code: 'PROFESSIONAL_ACCESSIBILITY_UNAVAILABLE', status: 503 },
  );
});

test('local application composes the authoritative form service into source-bound delivery', async () => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'c'.repeat(64) });
  try {
    const sourcePdf = makeButtonWidgetPdf();
    const document = await addDocument(application.store, sourcePdf);
    const result = await application.professionalCapabilities.deliverSourceBound(
      'accessibility.form-semantics', document.id, formRequest(sourcePdf),
    );
    assert.equal(result.method, 'production-accessibility-form-semantics-service');
    assert.equal(result.artifact.documentId, document.id);
    assert.equal(application.store.getArtifact(result.artifact.id).sha256, result.outputSha256);
    await application.store.deleteArtifact(result.artifact.id);
  } finally {
    await application.close();
  }
});

test('source-bound facade revokes a promoted form artifact on invalid delivery and cancellation', async (t) => {
  for (const mode of ['invalid-result', 'cancelled']) {
    const store = await initializedStore(t, mode);
    const sourcePdf = makeButtonWidgetPdf();
    const document = await addDocument(store, sourcePdf);
    const request = formRequest(sourcePdf);
    const controller = new AbortController();
    const deleted = [];
    const facadeStore = {
      verifySource: store.verifySource.bind(store),
      getDocument: store.getDocument.bind(store),
      getSourcePath: store.getSourcePath.bind(store),
      getArtifact: store.getArtifact.bind(store),
      async deleteArtifact(id) { deleted.push(id); return store.deleteArtifact(id); },
    };
    const realService = new PdfAccessibilityFormSemanticsService({ store });
    const service = mode === 'cancelled' ? {
      async repair(...args) {
        const receipt = await realService.repair(...args);
        controller.abort();
        return receipt;
      },
    } : realService;
    const professional = delivery(
      facadeStore,
      { accessibilityFormSemantics: service },
      async (capabilityId, context) => {
        const result = await HANDLERS[capabilityId](context);
        return mode === 'invalid-result' ? { ...result, professionalProof: false } : result;
      },
    );
    await assert.rejects(
      professional.deliverSourceBound('accessibility.form-semantics', document.id, request, { signal: controller.signal }),
      (error) => mode === 'cancelled' ? error?.code === 'JOB_CANCELLED' : error?.code === 'PROFESSIONAL_ACCESSIBILITY_RECEIPT_INVALID',
    );
    assert.equal(deleted.length, 1, mode);
    assert.throws(() => store.getArtifact(deleted[0]), { code: 'ARTIFACT_NOT_FOUND' });
  }
});
