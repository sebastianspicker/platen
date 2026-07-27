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

test('installed PDFKit helper adds exactly one source-bound open ink path with a private compact receipt', { skip: !canRunIntegration() }, async () => {
  const source = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (existing inert note) /DA (/F1 12 Tf 0 g) >>',
    pageExtra: ' /CropBox [10 20 510 720] /Rotate 90',
  });
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-ink-'));
  await chmod(workspace, 0o700);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  const ink = {
    page: 1,
    contents: 'private open ink contents',
    points: [{ x: 100, y: 200 }, { x: 180, y: 300 }, { x: 300, y: 400 }],
  };
  const { response, raw } = await runInkAnnotation(workspace, inkAnnotationRequest(sourceSha256(source), ink));

  assert.equal(response.ok, true, raw);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationIndex', 'appliedEdits', 'category', 'geometryVerified', 'operation', 'outputSha256',
    'page', 'pageCount', 'rawInkListVerified', 'reopenVerified', 'schema', 'sourceSha256', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'digest', outputSha256: 'digest' }, {
    schema: 'pdfkit-ink-receipt-v1', version: 1, operation: 'addInkAnnotation', category: 'ink-annotation',
    sourceSha256: 'digest', outputSha256: 'digest', page: 1, annotationIndex: 1, pageCount: 2,
    appliedEdits: 1, geometryVerified: true, rawInkListVerified: true, reopenVerified: true,
  });
  assert.equal(response.result.sourceSha256, sourceSha256(source));
  assert.match(response.result.outputSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(response.result.outputSha256, response.result.sourceSha256);
  assert.doesNotMatch(raw, /private open ink contents|"contents"|"points"|"x"|"y"/);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);

  const outputPath = join(workspace, 'output.pdf');
  const output = await readFile(outputPath);
  assert.equal(sourceSha256(output), response.result.outputSha256);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  const outputText = output.toString('latin1');
  assert.match(outputText, /\/Subtype\s*\/FreeText/);
  assert.match(outputText, /\/Contents\s*\(existing inert note\)/);
  assert.match(outputText, /\/Subtype\s*\/Ink/);
  assert.match(outputText, /\/InkList\s*\[\s*\[\s*100(?:\.0+)?\s+200(?:\.0+)?\s+180(?:\.0+)?\s+300(?:\.0+)?\s+300(?:\.0+)?\s+400(?:\.0+)?\s*\]\s*\]/);
  assert.doesNotMatch(outputText, /\/URI\b|\/GoToR\b|\/Launch\b|\/AA\b|\/RichMedia\b|\/Movie\b|\/Popup\b/);

  const inspection = await runInspection(workspace, 'output.pdf');
  assert.equal(inspection.response.ok, true);
  assert.deepEqual(inspection.response.result.pages.map(({ annotations }) => annotations.map(({ subtype }) => subtype)), [
    ['freeText', 'ink'], [],
  ]);
  assert.equal(inspection.response.result.pages[0].rotation, 90);
  assert.deepEqual(inspection.response.result.pages[0].boxes.crop, { x: 10, y: 20, width: 500, height: 700 });
});

test('installed PDFKit helper rejects malformed, stale, outside, duplicate, point-count, active, media, and over-quota ink requests', { skip: !canRunIntegration() }, async () => {
  const safeSource = makeMultiPagePdf(['ink source', 'ink target'], {
    cropBoxes: [[10, 20, 510, 720], [0, 0, 612, 792]],
  });
  const validInk = {
    page: 1, contents: 'private ink', points: [{ x: 100, y: 200 }, { x: 200, y: 300 }],
  };
  const activeSource = makeNavigationPdf();
  const mediaSource = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /RichMedia /Rect [72 540 272 700] /P 3 0 R /RichMediaContent 9 0 R /RichMediaSettings 10 0 R >>',
    extraObjects: [
      '<< /Assets << /Names [(remote-video) 11 0 R] >> /Configurations [12 0 R] >>',
      '<< /Activation << /Condition /PO /Configuration 12 0 R >> >>',
      '<< /Type /Filespec /FS /URL /F (https://example.invalid/auto.mp4) >>',
      '<< /Type /RichMediaConfiguration /Subtype /Video /Instances [] >>',
    ],
  });
  const quotaSource = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (existing inert note) /DA (/F1 12 Tf 0 g) >>',
  });
  const manyPoints = Array.from({ length: 33 }, (_value, index) => ({ x: 20 + index, y: 100 + index }));
  const rejected = [
    { source: safeSource, request: { ...inkAnnotationRequest(sourceSha256(safeSource), validInk), unexpected: true }, code: 'INVALID_REQUEST' },
    { source: safeSource, request: inkAnnotationRequest('0'.repeat(64), validInk), code: 'MUTATION_FAILED' },
    { source: safeSource, request: inkAnnotationRequest(sourceSha256(safeSource), { ...validInk, points: [{ x: 100, y: 200 }, { x: 520, y: 300 }] }), code: 'MUTATION_FAILED' },
    { source: safeSource, request: inkAnnotationRequest(sourceSha256(safeSource), { ...validInk, points: [{ x: 100, y: 200 }, { x: 100, y: 200 }] }), code: 'INVALID_REQUEST' },
    { source: safeSource, request: inkAnnotationRequest(sourceSha256(safeSource), { ...validInk, points: [{ x: 100, y: 200 }] }), code: 'INVALID_REQUEST' },
    { source: safeSource, request: inkAnnotationRequest(sourceSha256(safeSource), { ...validInk, points: manyPoints }), code: 'INVALID_REQUEST' },
    { source: safeSource, request: inkAnnotationRequest(sourceSha256(safeSource), { ...validInk, points: [{ x: null, y: 200 }, { x: 200, y: 300 }] }), code: 'INVALID_REQUEST' },
    { source: activeSource, request: inkAnnotationRequest(sourceSha256(activeSource), validInk), code: 'MUTATION_FAILED' },
    { source: mediaSource, request: inkAnnotationRequest(sourceSha256(mediaSource), validInk), code: 'MUTATION_FAILED' },
    { source: quotaSource, request: inkAnnotationRequest(sourceSha256(quotaSource), validInk, { ...limits, maxAnnotationsPerPage: 1 }), code: 'MUTATION_FAILED' },
  ];
  for (const entry of rejected) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-ink-reject-'));
    await chmod(workspace, 0o700);
    await writeFile(join(workspace, 'input.pdf'), entry.source, { mode: 0o600 });
    const { response } = await runInkAnnotation(workspace, entry.request);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: entry.code } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), entry.source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }

  const outputExistsWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-ink-output-exists-'));
  await chmod(outputExistsWorkspace, 0o700);
  await writeFile(join(outputExistsWorkspace, 'input.pdf'), safeSource, { mode: 0o600 });
  const existingOutput = Buffer.from('must not be replaced');
  await writeFile(join(outputExistsWorkspace, 'output.pdf'), existingOutput, { mode: 0o600 });
  const { response } = await runInkAnnotation(
    outputExistsWorkspace, inkAnnotationRequest(sourceSha256(safeSource), validInk),
  );
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'OUTPUT_EXISTS' } });
  assert.deepEqual(await readFile(join(outputExistsWorkspace, 'input.pdf')), safeSource);
  assert.deepEqual(await readFile(join(outputExistsWorkspace, 'output.pdf')), existingOutput);
});

test('installed PDFKit helper mutates metadata into a separate, reopened output', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-mutate-'));
  const source = makeTextPdf('source bytes must remain unchanged');
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const response = await runMutation(workspace, {
    ...emptyMutation(), metadata: { title: 'Title', author: 'Author', subject: null, keywords: 'one, two' },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'appliedEdits', 'category', 'inspection', 'operation', 'outputSha256', 'schema', 'sourceSha256', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'digest', outputSha256: 'digest' }, {
    schema: 'pdfkit-mutation-receipt-v1', version: 1, operation: 'mutate', category: 'structure-mutation',
    sourceSha256: 'digest', outputSha256: 'digest', appliedEdits: 4, inspection: response.result.inspection,
  });
  assert.equal(response.result.sourceSha256, sourceSha256(source));
  assert.equal(response.result.outputSha256, sourceSha256(await readFile(join(workspace, 'output.pdf'))));
  assert.equal(response.result.appliedEdits, 4);
  assert.equal(response.result.inspection.document.pageCount, 1);
  assert.equal(response.result.inspection.metadata.title, 'Title');
  assert.equal(response.result.inspection.metadata.author, 'Author');
  assert.equal(response.result.inspection.metadata.subject, null);
  assert.equal(response.result.inspection.metadata.keywords, 'one, two');
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.notDeepEqual(await readFile(join(workspace, 'output.pdf')), source);
});

test('installed PDFKit helper applies one bounded page-box or annotation mutation per output', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-mutate-'));
  await writeFile(join(workspace, 'input.pdf'), makeTextPdf('annotation source'), { mode: 0o600 });
  await chmod(workspace, 0o700);
  const response = await runMutation(workspace, {
    ...emptyMutation(),
    pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 10, width: 500, height: 700 } },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.appliedEdits, 1);
  assert.deepEqual(response.result.inspection.pages[0].boxes.crop, { x: 10, y: 10, width: 500, height: 700 });
  for (const subtype of ['text', 'freeText', 'square', 'circle', 'highlight']) {
    const annotationWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-mutate-'));
    const annotationSource = makeTextPdf('annotation source');
    await writeFile(join(annotationWorkspace, 'input.pdf'), annotationSource, { mode: 0o600 });
    await chmod(annotationWorkspace, 0o700);
    const annotationResponse = await runMutation(annotationWorkspace, {
      ...emptyMutation(), annotations: [{ page: 1, subtype, contents: `private-${subtype}`, rect: { x: 20, y: 100, width: 30, height: 20 } }],
    });
    assert.equal(annotationResponse.ok, true, `${subtype}: ${JSON.stringify(annotationResponse)}`);
    assert.equal(annotationResponse.result.appliedEdits, 1, subtype);
    const annotations = annotationResponse.result.inspection.pages[0].annotations;
    const created = annotations.filter((annotation) => annotation.subtype === subtype);
    assert.equal(created.length, 1, subtype);
    assert.equal(created[0].annotationIndex, 0, subtype);
    assert.match(created[0].fingerprint, /^[0-9a-f]{64}$/, subtype);
    if (subtype === 'text') {
      // PDFKit serializes a Text note with an associated Popup annotation.
      assert.deepEqual(annotations.map((annotation) => annotation.subtype), ['text', 'popup']);
    } else {
      assert.equal(annotations.length, 1, subtype);
    }
    const reopened = await runInspection(annotationWorkspace, 'output.pdf');
    assert.deepEqual(reopened.response.result.pages[0].annotations, annotations, subtype);
    assert.doesNotMatch(JSON.stringify(annotationResponse), new RegExp(`private-${subtype}`));
    assert.deepEqual(await readFile(join(annotationWorkspace, 'input.pdf')), annotationSource, subtype);
  }

  const boundedWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-mutate-'));
  const boundedSource = makeTextPdf('bounded sticky-note source');
  await writeFile(join(boundedWorkspace, 'input.pdf'), boundedSource, { mode: 0o600 });
  await chmod(boundedWorkspace, 0o700);
  const boundedRequest = mutationRequest({
    ...emptyMutation(),
    annotations: [{ page: 1, subtype: 'text', contents: 'private-text', rect: { x: 20, y: 100, width: 30, height: 20 } }],
  }, sourceSha256(boundedSource));
  boundedRequest.limits = { ...limits, maxAnnotationsPerPage: 1 };
  await writeFile(join(boundedWorkspace, 'request.json'), JSON.stringify(boundedRequest), { mode: 0o600 });
  const boundedRun = spawnSync(productPath, ['--request', join(boundedWorkspace, 'request.json')], {
    cwd: boundedWorkspace, encoding: 'utf8',
  });
  assert.equal(boundedRun.status, 0, boundedRun.stderr);
  assert.deepEqual(JSON.parse(boundedRun.stdout), { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  assert.deepEqual(await readFile(join(boundedWorkspace, 'input.pdf')), boundedSource);
  await assert.rejects(readFile(join(boundedWorkspace, 'output.pdf')), { code: 'ENOENT' });
});

test('installed PDFKit helper applies one source-bound page rotation and preserves unrelated page state', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-rotation-'));
  const source = makeMultiPagePdf(['rotation source one', 'rotation source two'], {
    rotations: [90, 180],
    cropBoxes: [[10, 20, 500, 700], [30, 40, 520, 710]],
    outlines: [{ title: 'first', page: 1 }, { title: 'second', page: 2 }],
  });
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const before = await runInspection(workspace);
  const response = await runMutation(workspace, {
    ...emptyMutation(), rotation: { page: 2, degrees: 270 },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.appliedEdits, 1);
  assert.deepEqual(response.result.inspection.pages.map((page) => page.rotation), [90, 270]);
  assert.deepEqual(response.result.inspection.pages.map((page) => page.boxes), before.response.result.pages.map((page) => page.boxes));
  assert.deepEqual(response.result.inspection.pages.map((page) => page.annotations), before.response.result.pages.map((page) => page.annotations));
  assert.equal(response.result.inspection.pageCount, before.response.result.pageCount);
  const reopened = await runInspection(workspace, 'output.pdf');
  assert.deepEqual(reopened.response.result, response.result.inspection);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.notDeepEqual(await readFile(join(workspace, 'output.pdf')), source);
});

test('installed PDFKit helper applies one selected-page crop box and preserves bounded unrelated page and annotation state', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-crop-'));
  const seed = makeMultiPagePdf(['crop source one', 'crop source two'], {
    rotations: [90, 180], cropBoxes: [[10, 20, 500, 700], [30, 40, 520, 710]],
  });
  await writeFile(join(workspace, 'input.pdf'), seed, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const source = seed;

  const before = await runInspection(workspace);
  // Expansion is intentionally supported within MediaBox and may reveal previously cropped content.
  const target = { x: 0, y: 0, width: 612, height: 792 };
  const response = await runMutation(workspace, {
    ...emptyMutation(), pageBox: { page: 1, box: 'crop', rect: target },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.appliedEdits, 1);
  assert.deepEqual(response.result.inspection.pages[0].boxes.crop, target);
  assert.deepEqual(
    response.result.inspection.pages.slice(1).map((page) => page.boxes.crop),
    before.response.result.pages.slice(1).map((page) => page.boxes.crop),
  );
  assert.deepEqual(
    response.result.inspection.pages.map(({ boxes }) => ({
      media: boxes.media, bleed: boxes.bleed, trim: boxes.trim, art: boxes.art,
    })),
    before.response.result.pages.map(({ boxes }) => ({
      media: boxes.media, bleed: boxes.bleed, trim: boxes.trim, art: boxes.art,
    })),
  );
  assert.deepEqual(
    response.result.inspection.pages.map((page) => page.rotation),
    before.response.result.pages.map((page) => page.rotation),
  );
  assert.deepEqual(
    response.result.inspection.pages.map((page) => ({
      count: page.annotations.length, subtypes: page.annotations.map((annotation) => annotation.subtype),
    })),
    before.response.result.pages.map((page) => ({
      count: page.annotations.length, subtypes: page.annotations.map((annotation) => annotation.subtype),
    })),
  );
  const reopened = await runInspection(workspace, 'output.pdf');
  assert.deepEqual(reopened.response.result, response.result.inspection);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.notDeepEqual(await readFile(join(workspace, 'output.pdf')), source);
});

test('installed PDFKit helper rejects malformed, no-op, outside, multi-category, unsafe, and pre-existing crop-box outputs', { skip: !canRunIntegration() }, async () => {
  const safeSource = makeTextPdf('crop source');
  const crop = { page: 1, box: 'crop', rect: { x: 10, y: 20, width: 500, height: 700 } };
  const rejected = [
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...crop, extra: true } }, code: 'INVALID_REQUEST' },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...crop, page: null } }, code: 'INVALID_REQUEST' },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...crop, rect: { x: 0, y: 0, width: 612, height: 792 } } }, code: 'MUTATION_FAILED' },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...crop, rect: { x: 600, y: 700, width: 20, height: 20 } } }, code: 'MUTATION_FAILED' },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...crop, page: 2 } }, code: 'MUTATION_FAILED' },
    {
      source: safeSource,
      mutation: { ...emptyMutation(), metadata: { title: 'also a category', author: null, subject: null, keywords: null }, pageBox: crop },
      code: 'INVALID_REQUEST',
    },
    { source: makeNavigationPdf(), mutation: { ...emptyMutation(), pageBox: crop }, code: 'MUTATION_FAILED' },
  ];
  for (const entry of rejected) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-crop-reject-'));
    await writeFile(join(workspace, 'input.pdf'), entry.source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const response = await runMutation(workspace, entry.mutation);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: entry.code } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), entry.source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }

  const normalizationWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-crop-normalization-'));
  const normalizingSource = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (existing inert note) /DA (/F1 12 Tf 0 g) >>',
    pageExtra: ' /CropBox [10 20 510 720] /Rotate 90',
  });
  await writeFile(join(normalizationWorkspace, 'input.pdf'), normalizingSource, { mode: 0o600 });
  await chmod(normalizationWorkspace, 0o700);
  const normalizedBefore = await runInspection(normalizationWorkspace);
  assert.deepEqual(normalizedBefore.response.result.pages.map((page) => page.annotations.map((annotation) => annotation.subtype)), [
    ['freeText'], [],
  ]);
  const normalizationResponse = await runMutation(normalizationWorkspace, {
    ...emptyMutation(), pageBox: { page: 1, box: 'crop', rect: { x: 0, y: 0, width: 612, height: 792 } },
  });
  assert.deepEqual(normalizationResponse, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  assert.deepEqual(await readFile(join(normalizationWorkspace, 'input.pdf')), normalizingSource);
  await assert.rejects(readFile(join(normalizationWorkspace, 'output.pdf')), { code: 'ENOENT' });

  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-crop-output-exists-'));
  const existingOutput = Buffer.from('must not be replaced');
  await writeFile(join(workspace, 'input.pdf'), safeSource, { mode: 0o600 });
  await writeFile(join(workspace, 'output.pdf'), existingOutput, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const response = await runMutation(workspace, { ...emptyMutation(), pageBox: crop });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'OUTPUT_EXISTS' } });
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), safeSource);
  assert.deepEqual(await readFile(join(workspace, 'output.pdf')), existingOutput);
});

test('installed PDFKit helper rejects malformed, multi-category, out-of-range, and no-op page rotations', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-rotation-'));
  await writeFile(join(workspace, 'input.pdf'), makeMultiPagePdf(['one', 'two'], { rotations: [0, 180] }), { mode: 0o600 });
  await chmod(workspace, 0o700);

  for (const mutation of [
    { ...emptyMutation(), rotation: { page: 1, degrees: 45 } },
    { ...emptyMutation(), rotation: { page: 1, degrees: 360 } },
    { ...emptyMutation(), rotation: { page: 1, degrees: 90, extra: true } },
    { ...emptyMutation(), rotation: { page: null, degrees: 90 } },
    { ...emptyMutation(), rotation: { page: 1, degrees: null } },
    {
      ...emptyMutation(), rotation: { page: 1, degrees: 90 },
      pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 10, width: 500, height: 700 } },
    },
  ]) {
    const response = await runMutation(workspace, mutation);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  }

  const floatRequest = mutationRequest(
    { ...emptyMutation(), rotation: { page: 1, degrees: 90 } },
    sourceSha256(await readFile(join(workspace, 'input.pdf'))),
  );
  const requestPath = join(workspace, 'request.json');
  await writeFile(requestPath, JSON.stringify(floatRequest).replace('"degrees":90', '"degrees":90.0'), { mode: 0o600 });
  let run = spawnSync(productPath, ['--request', requestPath], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });

  let response = await runMutation(workspace, { ...emptyMutation(), rotation: { page: 2, degrees: 180 } });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  response = await runMutation(workspace, { ...emptyMutation(), rotation: { page: 3, degrees: 90 } });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
});
