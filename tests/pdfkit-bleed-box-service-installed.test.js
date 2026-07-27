import { before, test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { PdfKitMutationService } from '../scripts/host/pdfkit-mutation-service.mjs';
import * as support from './host-pdfkit-test-support.js';

const {
  assert, chmod, mkdtemp, tmpdir, join, spawnSync,
  createProcessLimiter, DocumentStore, EngineRegistry, makeMultiPagePdf,
  packagePath, PDFKitAdapter, PopplerAdapter, projectPath,
  stagePdfKitHelper, verifyStagedPdfKitHelper, canRunIntegration,
} = support;

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync(
    'swift', ['build', '-c', 'release', '--package-path', packagePath],
    { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr);
});

test('installed host boundary publishes only a source-bound render-preserving BleedBox artifact', {
  skip: !canRunIntegration(), timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-host-bleed-box-'));
  await chmod(root, 0o700);
  const store = await new DocumentStore({ root: join(root, 'store') }).initialize();
  try {
    const staged = await stagePdfKitHelper({ root: projectPath, sessionRoot: root });
    assert.equal(staged.available, true);
    const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
    const registry = new EngineRegistry({ runner });
    const poppler = new PopplerAdapter({ registry, runner });
    const pdfkit = new PDFKitAdapter({
      executable: staged.executable,
      expectedSha256: staged.sha256,
      verifyExecutable: verifyStagedPdfKitHelper,
      runner,
    });
    const service = new PdfKitMutationService({ store, poppler, adapter: pdfkit });
    const source = makeMultiPagePdf(['bleed one', 'bleed two'], {
      cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]],
      bleedBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]],
      trimBoxes: [[20, 20, 592, 772], [20, 20, 592, 772]],
    });
    const document = await store.createDocument({
      stream: Readable.from([source]),
      displayName: 'bleed-source.pdf',
      mediaType: 'application/pdf',
    });
    const rect = { x: 10, y: 10, width: 592, height: 772 };
    const result = await service.mutate(document.id, {
      metadata: null,
      pageBox: { page: 1, box: 'bleed', rect },
      rotation: null,
      annotations: [],
    }, { sourceSha256: document.sha256, profile: 'macos-pdfkit-derived-v1' });

    assert.equal(result.evidence.persistentBleedBoxVerified, true);
    assert.equal(result.evidence.allPageValidationRendersMatched, true);
    assert.deepEqual({ ...result.postflight.pages[0].boxes.bleed }, rect);
    assert.equal(result.artifact.displayName, 'bleed-source-page-1-bleed-box.pdf');
    assert.equal(result.artifact.operation.validation.bleedBoxPage, 1);
    assert.deepEqual({ ...result.artifact.operation.validation.persistentBleedBox }, rect);
    assert.equal(await store.verifySource(document.id), true);
    const retained = store.getArtifact(result.artifact.id);
    assert.notDeepEqual(await readFile(retained.filePath), source);
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
