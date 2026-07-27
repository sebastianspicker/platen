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

test('installed PDFKit helper reads input by descriptor and rejects links or oversized input', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-'));
  const request = join(workspace, 'request.json');
  const input = join(workspace, 'input.pdf');
  const actual = join(workspace, 'actual.pdf');
  await chmod(workspace, 0o700);
  await writeFile(actual, makeTextPdf('descriptor input'), { mode: 0o600 });
  await writeFile(request, JSON.stringify({
    version: 1, operation: 'inspect', inputFilename: 'input.pdf',
    limits: { maxPages: 1, maxAnnotationsPerPage: 0, maxWidgetsPerPage: 0, maxOutlineDepth: 0, maxOutlineItems: 0 },
  }), { mode: 0o600 });

  await symlink(actual, input);
  let run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'UNSAFE_WORKSPACE' } });
  await unlink(input);
  await link(actual, input);
  run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'UNSAFE_WORKSPACE' } });
  await unlink(input);
  const oversized = await open(input, 'wx', 0o600);
  await oversized.truncate((128 * 1024 * 1024) + 1);
  await oversized.close();
  run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'INPUT_TOO_LARGE' } });
});

test('installed PDFKit helper adds exactly one digest-bound local GoTo link with a private compact receipt', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-local-goto-'));
  const source = makeMultiPagePdf(['private source page one', 'private target page two'], {
    cropBoxes: [[0, 0, 500, 700], [10, 20, 510, 720]],
    outlines: [{ title: 'private existing outline', page: 1 }],
  });
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const link = { sourcePage: 1, targetPage: 2, rect: { x: 40, y: 600, width: 180, height: 30 } };
  const { response, raw } = await runLocalGoTo(workspace, localGoToRequest(sourceSha256(source), link));

  assert.equal(response.ok, true, raw);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationIndex', 'appliedEdits', 'category', 'localGoToActionVerified', 'operation', 'outputSha256',
    'pageCount', 'rawDestinationVerified', 'reopenVerified', 'schema', 'sourcePage', 'sourceSha256',
    'targetPage', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'digest', outputSha256: 'digest' }, {
    schema: 'pdfkit-local-goto-receipt-v1', version: 1, operation: 'addLocalGoToLink',
    category: 'local-goto-link', sourceSha256: 'digest', outputSha256: 'digest',
    sourcePage: 1, targetPage: 2, annotationIndex: 0, pageCount: 2, appliedEdits: 1,
    rawDestinationVerified: true, localGoToActionVerified: true, reopenVerified: true,
  });
  assert.equal(response.result.sourceSha256, sourceSha256(source));
  assert.match(response.result.outputSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(response.result.outputSha256, response.result.sourceSha256);
  assert.doesNotMatch(raw, /private source|private target|private existing outline|"rect"|"x"|"y"|"width"|"height"/);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);

  const output = await readFile(join(workspace, 'output.pdf'));
  assert.equal(sourceSha256(output), response.result.outputSha256);
  assert.equal((await stat(join(workspace, 'output.pdf'))).mode & 0o777, 0o600);
  const outputText = output.toString('latin1');
  assert.match(outputText, /\/Subtype\s*\/Link/);
  assert.match(outputText, /\/Dest\s*\[/);
  assert.match(outputText, /\/A\s+\d+\s+0\s+R/);
  assert.match(outputText, /\/S\s*\/GoTo\s*\/D\s*\[/);
  assert.doesNotMatch(outputText, /\/URI\b|\/GoToR\b|\/Launch\b|\/AA\b/);

  const inspection = await runInspection(workspace, 'output.pdf');
  assert.equal(inspection.response.ok, true);
  assert.deepEqual(inspection.response.result.pages.map(({ annotations }) => annotations.map(({ subtype }) => subtype)), [
    ['link'], [],
  ]);
  assert.deepEqual(inspection.response.result.pages[0].links.map((item) => ({
    annotationIndex: item.annotationIndex, kind: item.kind, targetPage: item.targetPage,
    target: item.target, remotePage: item.remotePage,
  })), [{ annotationIndex: 0, kind: 'goTo', targetPage: 2, target: null, remotePage: null }]);
  assert.deepEqual(inspection.response.result.outline.items, [{
    title: 'private existing outline', page: 1, children: [], removalLocator: null,
  }]);
});

test('installed PDFKit helper rejects malformed, stale, unsafe, out-of-bounds, and over-quota local GoTo requests', { skip: !canRunIntegration() }, async () => {
  const safeSource = makeMultiPagePdf(['source', 'target'], { cropBoxes: [[0, 0, 500, 700], [10, 20, 510, 720]] });
  const validLink = { sourcePage: 1, targetPage: 2, rect: { x: 40, y: 600, width: 180, height: 30 } };
  const rejected = [
    { source: safeSource, request: { ...localGoToRequest(sourceSha256(safeSource), validLink), unexpected: true }, code: 'INVALID_REQUEST' },
    { source: safeSource, request: localGoToRequest('0'.repeat(64), validLink), code: 'MUTATION_FAILED' },
    { source: safeSource, request: localGoToRequest(sourceSha256(safeSource), { ...validLink, targetPage: 3 }), code: 'MUTATION_FAILED' },
    { source: safeSource, request: localGoToRequest(sourceSha256(safeSource), { ...validLink, rect: { x: 490, y: 690, width: 20, height: 20 } }), code: 'MUTATION_FAILED' },
    { source: safeSource, request: localGoToRequest(sourceSha256(safeSource), validLink, { ...limits, maxPages: 1 }), code: 'MUTATION_FAILED' },
    { source: makeNavigationPdf(), request: null, code: 'MUTATION_FAILED' },
    { source: makeLocatorPdf(), request: null, code: 'MUTATION_FAILED' },
    { source: makeMultiPagePdf(['attachment source', 'target'], { attachment: { name: 'private.txt', content: 'private' } }), request: null, code: 'MUTATION_FAILED' },
    { source: makeMultiPagePdf(['outline source', 'target'], { outlines: [{ title: 'outline', page: 1 }] }), request: null, code: 'MUTATION_FAILED', requestLimits: { ...limits, maxOutlineItems: 0 } },
  ];
  for (const entry of rejected) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-local-goto-reject-'));
    await writeFile(join(workspace, 'input.pdf'), entry.source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const request = entry.request ?? localGoToRequest(
      sourceSha256(entry.source), validLink, entry.requestLimits ?? limits,
    );
    const { response } = await runLocalGoTo(workspace, request);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: entry.code } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), entry.source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }

  const fixtureWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-local-goto-quota-fixture-'));
  const fixtureSource = makeMultiPagePdf(['annotated source', 'target']);
  await writeFile(join(fixtureWorkspace, 'input.pdf'), fixtureSource, { mode: 0o600 });
  await chmod(fixtureWorkspace, 0o700);
  const inertResult = await runMutation(fixtureWorkspace, {
    ...emptyMutation(), annotations: [{ page: 1, subtype: 'freeText', contents: 'private', rect: { x: 20, y: 100, width: 30, height: 20 } }],
  });
  assert.equal(inertResult.ok, true);
  const overQuotaSource = await readFile(join(fixtureWorkspace, 'output.pdf'));
  const overQuotaWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-local-goto-quota-'));
  await writeFile(join(overQuotaWorkspace, 'input.pdf'), overQuotaSource, { mode: 0o600 });
  await chmod(overQuotaWorkspace, 0o700);
  const overQuota = await runLocalGoTo(overQuotaWorkspace, localGoToRequest(
    sourceSha256(overQuotaSource), validLink, { ...limits, maxAnnotationsPerPage: 1 },
  ));
  assert.deepEqual(overQuota.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  assert.deepEqual(await readFile(join(overQuotaWorkspace, 'input.pdf')), overQuotaSource);
  await assert.rejects(readFile(join(overQuotaWorkspace, 'output.pdf')), { code: 'ENOENT' });
});

test('installed PDFKit helper rejects attachment and auto-activating annotation graphs before local GoTo output', { skip: !canRunIntegration() }, async () => {
  const link = { sourcePage: 1, targetPage: 2, rect: { x: 40, y: 600, width: 180, height: 30 } };
  const richMedia = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /RichMedia /Rect [72 540 272 700] /P 3 0 R /RichMediaContent 9 0 R /RichMediaSettings 10 0 R >>',
    extraObjects: [
      '<< /Assets << /Names [(remote-video) 11 0 R] >> /Configurations [12 0 R] >>',
      '<< /Activation << /Condition /PO /Configuration 12 0 R /Animation << /Subtype /Linear /PlayCount -1 /Speed 1 >> >> >>',
      '<< /Type /Filespec /FS /URL /F (https://example.invalid/auto.mp4) /UF (https://example.invalid/auto.mp4) >>',
      '<< /Type /RichMediaConfiguration /Subtype /Video /Instances [13 0 R] >>',
      '<< /Type /RichMediaInstance /Subtype /Video /Asset 11 0 R /Params << /Binding /Foreground >> >>',
    ],
  });
  const fixtures = [
    richMedia,
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /Movie /Rect [72 540 272 700] /P 3 0 R /Movie << /F (https://example.invalid/movie.mov) /Aspect [100 68] /Poster false >> >>',
    }),
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /Sound /Rect [72 540 272 700] /P 3 0 R /Sound 9 0 R >>',
      extraObjects: ['<< /R 8000 /C 1 /B 8 /E /Signed /Length 8 >>\nstream\n12345678\nendstream'],
    }),
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /3D /Rect [72 540 272 700] /P 3 0 R /3DD 9 0 R /3DV /Default /3DA << /A /PO /AIS /L >> >>',
      extraObjects: ['<< /Type /3D /Subtype /U3D /Length 4 >>\nstream\nU3D!\nendstream'],
    }),
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /Screen /Rect [72 540 272 700] /P 3 0 R /T (screen target) /MK << /TP 0 >> >>',
    }),
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /FileAttachment /Rect [72 540 92 560] /P 3 0 R /FS << /Type /Filespec /F (payload.txt) /UF (payload.txt) /EF << /F 9 0 R >> >> >>',
      extraObjects: ['<< /Type /EmbeddedFile /Length 7 >>\nstream\npayload\nendstream'],
    }),
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (looks inert) /DA (/F1 12 Tf 0 g) /FS 9 0 R >>',
      extraObjects: ['<< /Type /Filespec /FS /URL /F (https://example.invalid/disguised) >>'],
    }),
    makeLocalGoToAnnotationFixture({
      annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (page attachment) /DA (/F1 12 Tf 0 g) >>',
      pageExtra: ' /AF [9 0 R]',
      extraObjects: ['<< /Type /Filespec /F (page-associated.bin) >>'],
    }),
  ];

  for (const source of fixtures) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-local-goto-active-reject-'));
    await chmod(workspace, 0o700);
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    const { response } = await runLocalGoTo(workspace, localGoToRequest(sourceSha256(source), link));
    assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }
});

test('installed PDFKit helper bounds Popup relationships before line and ink output', { skip: !canRunIntegration() }, async () => {
  const activeHiddenPopup = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (inert parent) /Popup 9 0 R >>',
    extraObjects: ['<< /Type /Annot /Subtype /Popup /Rect [72 540 272 580] /Parent 8 0 R /A << /S /URI /URI (https://example.invalid/child) >> >>'],
  });
  const activeHiddenParent = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /Popup /Rect [72 540 272 580] /Parent 9 0 R >>',
    extraObjects: ['<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (active parent) /Popup 8 0 R /A << /S /URI /URI (https://example.invalid/parent) >> >>'],
  });
  for (const source of [activeHiddenPopup, activeHiddenParent]) {
    for (const [kind, request] of [
      ['line', lineAnnotationRequest(sourceSha256(source), {
        page: 1, contents: 'private line', start: { x: 100, y: 200 }, end: { x: 300, y: 400 },
      })],
      ['ink', inkAnnotationRequest(sourceSha256(source), {
        page: 1, contents: 'private ink', points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
      })],
    ]) {
      const workspace = await mkdtemp(join(tmpdir(), `pdfkit-helper-popup-${kind}-reject-`));
      await chmod(workspace, 0o700);
      await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
      const result = kind === 'line' ? await runLineAnnotation(workspace, request) : await runInkAnnotation(workspace, request);
      assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
      assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
      await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
    }
  }

  const inertPair = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (inert parent) /Popup 9 0 R >>',
    extraObjects: ['<< /Type /Annot /Subtype /Popup /Rect [72 540 272 580] /Parent 8 0 R >>'],
    annotationReferences: '8 0 R 9 0 R',
  });
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-popup-inert-'));
  await chmod(workspace, 0o700);
  await writeFile(join(workspace, 'input.pdf'), inertPair, { mode: 0o600 });
  const result = await runLineAnnotation(workspace, lineAnnotationRequest(sourceSha256(inertPair), {
    page: 1, contents: 'private line', start: { x: 100, y: 200 }, end: { x: 300, y: 400 },
  }));
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), inertPair);
  await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
});

test('installed PDFKit helper preserves an explicitly allowed inert annotation while adding a local GoTo link', { skip: !canRunIntegration() }, async () => {
  const source = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (inert note) /DA (/F1 12 Tf 0 g) >>',
  });
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-local-goto-inert-'));
  await chmod(workspace, 0o700);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  const { response } = await runLocalGoTo(workspace, localGoToRequest(sourceSha256(source), {
    sourcePage: 1, targetPage: 2, rect: { x: 40, y: 600, width: 180, height: 30 },
  }));

  assert.equal(response.ok, true);
  const inspection = await runInspection(workspace, 'output.pdf');
  assert.equal(inspection.response.ok, true);
  assert.deepEqual(inspection.response.result.pages[0].annotations.map(({ subtype }) => subtype), ['freeText', 'link']);
});

test('installed PDFKit helper adds exactly one digest-bound inert line with a private compact receipt', { skip: !canRunIntegration() }, async () => {
  const source = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (existing inert note) /DA (/F1 12 Tf 0 g) >>',
  });
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-line-'));
  await chmod(workspace, 0o700);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  const line = {
    page: 1,
    contents: 'private straight line contents',
    start: { x: 100, y: 200 },
    end: { x: 300, y: 400 },
  };
  const { response, raw } = await runLineAnnotation(
    workspace, lineAnnotationRequest(sourceSha256(source), line),
  );

  assert.equal(response.ok, true, raw);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationIndex', 'appliedEdits', 'category', 'geometryVerified', 'lineStylesVerified',
    'operation', 'outputSha256', 'page', 'pageCount', 'reopenVerified', 'schema',
    'sourceSha256', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'digest', outputSha256: 'digest' }, {
    schema: 'pdfkit-line-receipt-v1', version: 1, operation: 'addLineAnnotation',
    category: 'line-annotation', sourceSha256: 'digest', outputSha256: 'digest',
    page: 1, annotationIndex: 1, pageCount: 2, appliedEdits: 1,
    geometryVerified: true, lineStylesVerified: true, reopenVerified: true,
  });
  assert.equal(response.result.sourceSha256, sourceSha256(source));
  assert.match(response.result.outputSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(response.result.outputSha256, response.result.sourceSha256);
  assert.doesNotMatch(raw, /private straight line contents|"contents"|"start"|"end"|"x"|"y"/);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);

  const outputPath = join(workspace, 'output.pdf');
  const output = await readFile(outputPath);
  assert.equal(sourceSha256(output), response.result.outputSha256);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  const outputText = output.toString('latin1');
  assert.match(outputText, /\/Subtype\s*\/FreeText/);
  assert.match(outputText, /\/Contents\s*\(existing inert note\)/);
  assert.match(outputText, /\/Subtype\s*\/Line/);
  assert.match(outputText, /\/L\s*\[\s*100(?:\.0+)?\s+200(?:\.0+)?\s+300(?:\.0+)?\s+400(?:\.0+)?\s*\]/);
  assert.match(outputText, /\/LE\s*\[\s*\/None\s+\/None\s*\]/);
  assert.doesNotMatch(outputText, /\/URI\b|\/GoToR\b|\/Launch\b|\/AA\b|\/RichMedia\b|\/Movie\b/);

  const inspection = await runInspection(workspace, 'output.pdf');
  assert.equal(inspection.response.ok, true);
  assert.deepEqual(inspection.response.result.pages.map(({ annotations }) => annotations.map(({ subtype }) => subtype)), [
    ['freeText', 'line'], [],
  ]);
});

test('installed PDFKit helper rejects malformed, stale, out-of-CropBox, coincident, active, media, and over-quota line requests', { skip: !canRunIntegration() }, async () => {
  const safeSource = makeMultiPagePdf(['line source', 'line target'], {
    cropBoxes: [[10, 20, 510, 720], [0, 0, 612, 792]],
  });
  const validLine = {
    page: 1, contents: 'private line', start: { x: 100, y: 200 }, end: { x: 300, y: 400 },
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
  const rejected = [
    {
      source: safeSource,
      request: { ...lineAnnotationRequest(sourceSha256(safeSource), validLine), unexpected: true },
      code: 'INVALID_REQUEST',
    },
    {
      source: safeSource,
      request: lineAnnotationRequest('0'.repeat(64), validLine),
      code: 'MUTATION_FAILED',
    },
    {
      source: safeSource,
      request: lineAnnotationRequest(sourceSha256(safeSource), {
        ...validLine, end: { x: 520, y: 400 },
      }),
      code: 'MUTATION_FAILED',
    },
    {
      source: safeSource,
      request: lineAnnotationRequest(sourceSha256(safeSource), {
        ...validLine, end: validLine.start,
      }),
      code: 'INVALID_REQUEST',
    },
    {
      source: safeSource,
      request: lineAnnotationRequest(sourceSha256(safeSource), { ...validLine, page: 3 }),
      code: 'MUTATION_FAILED',
    },
    {
      source: activeSource,
      request: lineAnnotationRequest(sourceSha256(activeSource), validLine),
      code: 'MUTATION_FAILED',
    },
    {
      source: mediaSource,
      request: lineAnnotationRequest(sourceSha256(mediaSource), validLine),
      code: 'MUTATION_FAILED',
    },
    {
      source: quotaSource,
      request: lineAnnotationRequest(
        sourceSha256(quotaSource), validLine, { ...limits, maxAnnotationsPerPage: 1 },
      ),
      code: 'MUTATION_FAILED',
    },
  ];

  for (const entry of rejected) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-line-reject-'));
    await chmod(workspace, 0o700);
    await writeFile(join(workspace, 'input.pdf'), entry.source, { mode: 0o600 });
    const { response } = await runLineAnnotation(workspace, entry.request);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: entry.code } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), entry.source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }
});
