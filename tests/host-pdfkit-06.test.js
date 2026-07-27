import { before, test } from 'node:test';
import * as support from './host-pdfkit-test-support.js';
const { assert, chmod, link, mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile, tmpdir, join, spawnSync,
  createHash, Readable, fileURLToPath, makeMultiPagePdf, makeTextPdf, PDFKitAdapter, parsePdfkitResponse, PopplerAdapter,
  DocumentStore, EngineRegistry, stagePdfKitHelper, verifyStagedPdfKitHelper, PdfKitSanitizationService, createProcessLimiter,
  packageRoot, packagePath, projectPath, productPath, limits, mutationRequest, emptyMutation, sourceSha256, targetedMutationRequest,
  localGoToRequest, lineAnnotationRequest, inkAnnotationRequest, protectionRequest, protectionRemovalRequest,
  metadataSanitizationRequest, makeMetadataSanitizationPdf, makeLocatorPdf, makeTargetedSanitizationPdf,
  parseClassicPdfAnnotationPages, makeButtonWidgetPdf, makeCustomCheckboxPdf, makeCanonicalRadioPdf, pdfUtf16TextToken,
  makeNavigationPdf, makeLocalGoToAnnotationFixture, runInspection, runMutation, runTargetedMutation,
  deriveTargetedSanitizationSource, runLocalGoTo, runLineAnnotation, runInkAnnotation, runProtection, runProtectionRemoval,
  runMetadataSanitization, directlyEncryptFixture, nativeContentHashes, locatorWorkspace, canRunIntegration } = support;

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const releaseBuild = spawnSync('swift', ['build', '-c', 'release', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(releaseBuild.status, 0, releaseBuild.stderr);
});

test('installed PDFKit helper rejects unsafe, invalid, and pre-existing mutation outputs', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-mutate-'));
  await writeFile(join(workspace, 'input.pdf'), makeTextPdf('source'), { mode: 0o600 });
  await chmod(workspace, 0o700);
  let response = await runMutation(workspace, emptyMutation());
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });

  response = await runMutation(workspace, {
    ...emptyMutation(), metadata: { title: null, author: null, subject: null, keywords: null },
    pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 10, width: 500, height: 700 } },
  });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });

  response = await runMutation(workspace, { ...emptyMutation(), formField: 'unsupported' });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });

  response = await runMutation(workspace, {
    ...emptyMutation(), metadata: { title: null, author: null, subject: null, keywords: null },
  });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });

  response = await runMutation(workspace, {
    ...emptyMutation(), annotations: [{ page: 1, subtype: 'text', contents: 'off-page', rect: { x: 600, y: 700, width: 20, height: 20 } }],
  });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });

  await writeFile(join(workspace, 'output.pdf'), 'already here', { mode: 0o600 });
  response = await runMutation(workspace, { ...emptyMutation(), metadata: { title: 'output exists', author: null, subject: null, keywords: null } });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'OUTPUT_EXISTS' } });
  await unlink(join(workspace, 'output.pdf'));
  await symlink(join(workspace, 'input.pdf'), join(workspace, 'output.pdf'));
  response = await runMutation(workspace, { ...emptyMutation(), metadata: { title: 'output exists', author: null, subject: null, keywords: null } });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'OUTPUT_EXISTS' } });
});

test('installed PDFKit helper rejects wrong and replayed standard-mutation digests before output', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-source-digest-'));
  const source = makeTextPdf('source digest binding');
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const requestPath = join(workspace, 'request.json');
  const mutation = { ...emptyMutation(), metadata: { title: 'bound output', author: null, subject: null, keywords: null } };
  for (const digest of ['0'.repeat(64), sourceSha256(Buffer.concat([source, Buffer.from('\n% replay')]))]) {
    await writeFile(requestPath, JSON.stringify(mutationRequest(mutation, digest)), { mode: 0o600 });
    const run = spawnSync(productPath, ['--request', requestPath], { cwd: workspace, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
});
