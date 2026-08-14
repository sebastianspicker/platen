import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { handlers } from '../scripts/host/professional-capability/content-editing.mjs';
import { PDF_PAGE_HEADER_FOOTER_PROFILE } from '../scripts/host/pdf-page-header-footer-contract.mjs';
import { writePdfPageHeaderFooter } from '../scripts/host/pdf-page-header-footer-writer.mjs';
test('edit.headers-footers requires the production service and validates retained bytes without exposing text', async () => {
  const source = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const request = { profile: PDF_PAGE_HEADER_FOOTER_PROFILE, sourceSha256, pages: [1], header: 'TOP', footerPrefix: 'Page ' };
  const written = writePdfPageHeaderFooter(source, request);
  const artifact = {
    id: '22222222-2222-4222-8222-222222222222',
    documentId: '11111111-1111-4111-8111-111111111111',
    displayName: 'page-header-footer.pdf',
    mediaType: 'application/pdf',
    size: written.bytes.length,
    sha256: createHash('sha256').update(written.bytes).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  const receipt = {
    kind: 'pdf-page-header-footer',
    artifact,
    pages: [{ page: 1, applied: true }],
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      headerFooterEffectProven: true,
      onlySelectedPagesChanged: true,
      pageBoxesPreserved: true,
      resourcesPreserved: true,
      annotationsPreserved: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [
      'Only fixed black monospaced Courier headers and automatic page-number footers are added to selected unrotated pages in a bounded passive classic PDF subset.',
      'This operation does not support forms, actions, tags, layers, signatures, encryption, templates, images, transparency, rotated pages, or complex PDF structures.',
      'The source revision remains the historical prefix; the result is a separately retained append-only artifact.',
    ],
  };
  const result = await handlers['edit.headers-footers']({
    documentId: artifact.documentId,
    sourcePdf: source,
    sourceSha256,
    pages: [1],
    header: 'TOP',
    footerPrefix: 'Page ',
    pageHeaderFooter: { create: async () => receipt },
    readArtifact: async () => written.bytes,
  });
  assert.equal(result.method, 'production-pdf-page-header-footer-service');
  assert.equal(JSON.stringify(result).includes('TOP'), false);
  assert.equal('pdf' in result, false);
  assert.equal(written.bytes.every((byte) => byte === 0), true);
});

test('composed local application routes edit.headers-footers through retained source-bound delivery', { timeout: 30_000 }, async (t) => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'h'.repeat(64) });
  t.after(() => application.close());
  const source = makeMultiPagePdf(['one', 'two'], {
    cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]],
  });
  const document = await application.store.createDocument({
    stream: Readable.from([source]),
    displayName: 'header-footer-source.pdf',
    mediaType: 'application/pdf',
  });
  let hostileAliasCalled = false;
  const outcome = await application.professionalCapabilities.deliver('edit.headers-footers', {
    documentId: document.id,
    pages: [1],
    header: 'CONFIDENTIAL',
    footerPrefix: 'Page ',
    pageHeaderFooterService: {
      async create() {
        hostileAliasCalled = true;
        throw Object.assign(new Error('hostile alias called'), { code: 'ALIAS_CALLED' });
      },
    },
  });
  const retained = application.store.getArtifact(outcome.artifact.id);
  const bytes = await readFile(retained.filePath);
  assert.equal(outcome.method, 'production-pdf-page-header-footer-service');
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(retained.sha256, outcome.outputSha256);
  assert.equal(bytes.subarray(0, source.length).equals(source), true);
  assert.deepEqual(outcome.pages, [{ page: 1, applied: true }]);
  assert.equal(outcome.evidence.headerFooterEffectProven, true);
  assert.equal(hostileAliasCalled, false);
  assert.doesNotMatch(JSON.stringify(outcome), /CONFIDENTIAL|filePath|sourceSha256|%PDF/u);
  await application.store.deleteArtifact(outcome.artifact.id);
});
