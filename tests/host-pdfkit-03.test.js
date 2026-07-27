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

test('installed PDFKit helper rejects unsafe, malformed, stale, required, and no-op choice clears', { skip: !canRunIntegration() }, async () => {
  const rejectedFixtures = [
    { choiceFlags: 1 << 1 }, { choiceFlags: 1 << 18 }, { choiceFlags: 1 << 21 }, { choiceFlags: 1 },
    { choiceWithAction: true }, { sharedFieldName: true }, { emptyChoiceFieldName: true },
    { choiceOptions: [] }, { choiceOptions: [''] }, { choiceOptions: ['one', 'one'] }, { choiceInitialValue: 'not-an-option' },
    { catalogExtra: ' /OpenAction << /S /URI /URI (https://example.invalid) >>' },
    { acroFormExtra: ' /XFA (prohibited)' }, { acroFormExtra: ' /CO []' }, { hiddenSignature: true },
  ];
  for (const options of rejectedFixtures) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-choice-clear-reject-'));
    const source = makeLocatorPdf(options);
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const choice = (await runInspection(workspace)).response.result.pages[0].widgets.find((widget) => widget.fieldType === 'choice');
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: { page: 1, annotationIndex: choice.annotationIndex, fingerprint: choice.fingerprint, fieldType: 'choice', value: '' },
      annotationUpdate: null, annotationRemove: null,
    }));
    assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } }, JSON.stringify(options));
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  }

  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-choice-clear-noop-'));
  const source = makeLocatorPdf({ choiceInitialValue: '' });
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const choice = (await runInspection(workspace)).response.result.pages[0].widgets.find((widget) => widget.fieldType === 'choice');
  const noOp = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
    formFill: { page: 1, annotationIndex: choice.annotationIndex, fingerprint: choice.fingerprint, fieldType: 'choice', value: '' },
    annotationUpdate: null, annotationRemove: null,
  }));
  assert.deepEqual(noOp.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });

  const changed = Buffer.concat([source, Buffer.from('% stale choice locator\n')]);
  await writeFile(join(workspace, 'input.pdf'), changed, { mode: 0o600 });
  const stale = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(changed), {
    formFill: { page: 1, annotationIndex: choice.annotationIndex, fingerprint: choice.fingerprint, fieldType: 'choice', value: '' },
    annotationUpdate: null, annotationRemove: null,
  }));
  assert.deepEqual(stale.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
});

test('installed PDFKit helper applies strict source-bound targeted mutations', { skip: !canRunIntegration() }, async () => {
  const textFixture = await locatorWorkspace();
  const textWidget = textFixture.inspection.pages[0].widgets.find((widget) => widget.fieldType === 'text');
  const textRequest = targetedMutationRequest(sourceSha256(textFixture.source), {
    formFill: { page: 1, annotationIndex: textWidget.annotationIndex, fingerprint: textWidget.fingerprint, fieldType: 'text', value: 'new text value' },
    annotationUpdate: null, annotationRemove: null,
  });
  const textResult = await runTargetedMutation(textFixture.workspace, textRequest);
  assert.equal(textResult.response.ok, true);
  assert.equal(textResult.response.result.appliedEdits, 1);
  assert.deepEqual((await runInspection(textFixture.workspace, 'output.pdf')).response.result, textResult.response.result.inspection);
  assert.deepEqual(await readFile(join(textFixture.workspace, 'input.pdf')), textFixture.source);
  assert.notDeepEqual(await readFile(join(textFixture.workspace, 'output.pdf')), textFixture.source);
  assert.doesNotMatch(textResult.raw, /new text value/);
  assert.doesNotMatch(textResult.raw, /fixture widget value must remain private/);
  assert.doesNotMatch(textResult.raw, new RegExp(textFixture.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const choiceFixture = await locatorWorkspace();
  const choiceWidget = choiceFixture.inspection.pages[0].widgets.find((widget) => widget.fieldType === 'choice');
  const choiceResult = await runTargetedMutation(choiceFixture.workspace, targetedMutationRequest(sourceSha256(choiceFixture.source), {
    formFill: { page: 1, annotationIndex: choiceWidget.annotationIndex, fingerprint: choiceWidget.fingerprint, fieldType: 'choice', value: 'two' },
    annotationUpdate: null, annotationRemove: null,
  }));
  assert.equal(choiceResult.response.ok, true);
  assert.equal(choiceResult.response.result.appliedEdits, 1);
  assert.deepEqual((await runInspection(choiceFixture.workspace, 'output.pdf')).response.result, choiceResult.response.result.inspection);
  assert.doesNotMatch(choiceResult.raw, /two/);

  const updateFixture = await locatorWorkspace();
  const freeText = updateFixture.inspection.pages[0].annotations.find((annotation) => annotation.subtype === 'freeText');
  const updateResult = await runTargetedMutation(updateFixture.workspace, targetedMutationRequest(sourceSha256(updateFixture.source), {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: freeText.annotationIndex, fingerprint: freeText.fingerprint, subtype: 'freeText',
      contents: 'updated annotation contents must remain private', rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationRemove: null,
  }));
  assert.equal(updateResult.response.ok, true);
  assert.equal(updateResult.response.result.appliedEdits, 1);
  assert.deepEqual((await runInspection(updateFixture.workspace, 'output.pdf')).response.result, updateResult.response.result.inspection);
  assert.doesNotMatch(updateResult.raw, /updated annotation contents must remain private/);

});

test('installed PDFKit helper proves selective annotation removal without emitting private annotation state', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-targeted-sanitization-'));
  await writeFile(join(workspace, 'input.pdf'), makeMultiPagePdf(['targeted annotation source', 'non-target annotation source']), { mode: 0o600 });
  await chmod(workspace, 0o700);
  const source = await deriveTargetedSanitizationSource(workspace);
  const before = await runInspection(workspace);
  const target = before.response.result.pages[0].annotations.find((annotation) => annotation.subtype === 'freeText');
  const rawBefore = parseClassicPdfAnnotationPages(source);
  assert.equal(target.annotationIndex, 0);
  assert.deepEqual(rawBefore.map((page) => page.map(({ subtype }) => subtype)), [
    ['FreeText', 'Circle'], ['Square'],
  ]);
  assert.equal(rawBefore[0][target.annotationIndex].subtype, 'FreeText');
  const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
    formFill: null, annotationUpdate: null,
    annotationRemove: {
      page: 1, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint, subtype: 'freeText',
    },
  }));

  assert.equal(result.response.ok, true, result.raw);
  assert.equal(result.response.result.appliedEdits, 1);
  assert.deepEqual(result.response.result.inspection.pages.map(({ annotations }) => annotations.map(({ subtype }) => subtype)), [
    ['circle'], ['square'],
  ]);
  const output = await readFile(join(workspace, 'output.pdf'));
  const rawAfter = parseClassicPdfAnnotationPages(output);
  const expectedRawAfter = rawBefore.map((page, pageIndex) => (
    pageIndex === 0 ? page.toSpliced(target.annotationIndex, 1) : page
  ));
  assert.deepEqual(rawAfter, expectedRawAfter);
  assert.deepEqual((await runInspection(workspace, 'output.pdf')).response.result, result.response.result.inspection);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.doesNotMatch(result.raw, /private targeted removal contents|private retained target-page contents|private non-target-page contents/);
});

test('installed PDFKit helper rejects unsafe or malformed reachable annotation graphs before targeted removal', { skip: !canRunIntegration() }, async () => {
  const fixtures = [
    makeTargetedSanitizationPdf({ targetExtra: ' /A << /S /URI /URI (https://example.invalid) >>' }),
    makeTargetedSanitizationPdf({ targetExtra: ' /AA << /E << /S /URI /URI (https://example.invalid) >> >>' }),
    makeTargetedSanitizationPdf({
      targetExtra: ' /Popup 12 0 R',
      extraObjects: ['<< /Type /Annot /Subtype /Popup /Rect [72 550 300 590] /Parent 8 0 R >>'],
    }),
    makeTargetedSanitizationPdf({ annotationReferences: '8 0 R 8 0 R 9 0 R' }),
    makeTargetedSanitizationPdf({ secondPageAnnotationReferences: '8 0 R' }),
    makeTargetedSanitizationPdf({ acroFormObject: '[]' }),
  ];
  for (const source of fixtures) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-targeted-sanitization-reject-'));
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const inspection = await runInspection(workspace);
    const target = inspection.response.result.pages[0].annotations.find((annotation) => annotation.subtype === 'freeText');
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: null, annotationUpdate: null,
      annotationRemove: {
        page: 1, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint, subtype: 'freeText',
      },
    }));
    assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }
});

test('installed PDFKit helper rejects malformed targeted mutation envelopes and mismatched locators', { skip: !canRunIntegration() }, async () => {
  const fixture = await locatorWorkspace();
  const textWidget = fixture.inspection.pages[0].widgets.find((widget) => widget.fieldType === 'text');
  const validMutation = {
    formFill: { page: 1, annotationIndex: textWidget.annotationIndex, fingerprint: textWidget.fingerprint, fieldType: 'text', value: 'safe' },
    annotationUpdate: null, annotationRemove: null,
  };
  const freeText = fixture.inspection.pages[0].annotations.find((annotation) => annotation.subtype === 'freeText');
  const invalidRequests = [
    { sourceDigest: 'A'.repeat(64), mutation: validMutation },
    {
      sourceDigest: sourceSha256(fixture.source),
      mutation: {
        ...validMutation,
        annotationRemove: {
          page: 1, annotationIndex: 2, fingerprint: 'a'.repeat(64), subtype: 'freeText',
        },
      },
    },
    { sourceDigest: sourceSha256(fixture.source), mutation: {
      formFill: null,
      annotationUpdate: {
        page: 1, annotationIndex: freeText.annotationIndex, fingerprint: freeText.fingerprint, subtype: 'text',
        contents: 'must not update sticky notes', rect: { x: 100, y: 520, width: 220, height: 50 },
      },
      annotationRemove: null,
    } },
    { sourceDigest: sourceSha256(fixture.source), mutation: {
      formFill: null, annotationUpdate: null,
      annotationRemove: { page: 1, annotationIndex: freeText.annotationIndex, fingerprint: freeText.fingerprint, subtype: 'text' },
    } },
    { sourceDigest: sourceSha256(fixture.source), mutation: {
      formFill: { ...validMutation.formFill, annotationIndex: 50 },
      annotationUpdate: null,
      annotationRemove: null,
    } },
  ];
  for (const { sourceDigest, mutation } of invalidRequests) {
    const response = await runTargetedMutation(
      fixture.workspace,
      targetedMutationRequest(sourceDigest, mutation),
    );
    assert.deepEqual(response.response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  }
});

test('installed PDFKit helper rejects changed, action-bearing, and signed targeted sources', { skip: !canRunIntegration() }, async () => {
  const fixture = await locatorWorkspace();
  const textWidget = fixture.inspection.pages[0].widgets.find((widget) => widget.fieldType === 'text');
  const validMutation = {
    formFill: { page: 1, annotationIndex: textWidget.annotationIndex, fingerprint: textWidget.fingerprint, fieldType: 'text', value: 'safe' },
    annotationUpdate: null, annotationRemove: null,
  };
  const changed = Buffer.concat([fixture.source, Buffer.from('% byte-different source\n')]);
  await writeFile(join(fixture.workspace, 'input.pdf'), changed, { mode: 0o600 });
  const response = await runTargetedMutation(
    fixture.workspace,
    targetedMutationRequest(sourceSha256(changed), validMutation),
  );
  assert.deepEqual(response.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  assert.doesNotMatch(response.raw, /safe/);

  for (const options of [{ withAction: true }, { withSignature: true }]) {
    const unsafeFixture = await locatorWorkspace(options);
    const unsafeWidget = unsafeFixture.inspection.pages[0].widgets.find((widget) => widget.fieldType === 'text');
    const rejected = await runTargetedMutation(unsafeFixture.workspace, targetedMutationRequest(sourceSha256(unsafeFixture.source), {
      formFill: { page: 1, annotationIndex: unsafeWidget.annotationIndex, fingerprint: unsafeWidget.fingerprint, fieldType: 'text', value: 'safe' },
      annotationUpdate: null, annotationRemove: null,
    }));
    assert.deepEqual(rejected.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  }
});

test('installed PDFKit helper rejects unsupported and ambiguous targeted form widgets', { skip: !canRunIntegration() }, async () => {
  const oversizedChoices = Array.from({ length: 51 }, (_, index) => `value-${index}`);
  const cases = [
    ...[1 << 20, 1 << 25].map((textFlags) => ({ options: { textFlags }, fieldType: 'text', value: 'safe' })),
    ...[1 << 18, 1 << 21].map((choiceFlags) => ({ options: { choiceFlags }, fieldType: 'choice', value: 'two' })),
    { options: { sharedFieldName: true }, fieldType: 'text', value: 'safe' },
    { options: { emptyTextFieldName: true }, fieldType: 'text', value: 'safe' },
    { options: { choiceOptions: ['one', 'one'] }, fieldType: 'choice', value: 'one' },
    { options: { choiceOptions: oversizedChoices }, fieldType: 'choice', value: oversizedChoices.at(-1) },
  ];
  for (const { options, fieldType, value } of cases) {
    const fixture = await locatorWorkspace(options);
    const widget = fixture.inspection.pages[0].widgets.find((entry) => entry.fieldType === fieldType);
    const response = await runTargetedMutation(fixture.workspace, targetedMutationRequest(sourceSha256(fixture.source), {
      formFill: { page: 1, annotationIndex: widget.annotationIndex, fingerprint: widget.fingerprint, fieldType, value },
      annotationUpdate: null, annotationRemove: null,
    }));
    assert.deepEqual(response.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  }
});

test('installed PDFKit helper resolves only direct and GoTo outline destinations to local pages', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-'));
  const request = join(workspace, 'request.json');
  await writeFile(join(workspace, 'input.pdf'), makeMultiPagePdf(['one', 'two'], {
    outlines: [
      { title: 'Direct destination', page: 1 },
      { title: 'GoTo action', page: 2, action: 'goTo', directDestination: false },
      { title: 'URI action', page: null, action: 'uri', directDestination: false },
      { title: 'Named action', page: null, action: 'named', directDestination: false },
      { title: 'Remote GoTo action', page: null, action: 'remoteGoTo', directDestination: false },
      { title: 'JavaScript action', page: null, action: 'javascript', directDestination: false },
      { title: 'Ambiguous direct and URI', page: 1, action: 'uri', directDestination: true },
    ],
  }), { mode: 0o400 });
  await writeFile(request, JSON.stringify({
    version: 1, operation: 'inspect', inputFilename: 'input.pdf',
    limits: { maxPages: 2, maxAnnotationsPerPage: 0, maxWidgetsPerPage: 0, maxOutlineDepth: 8, maxOutlineItems: 10 },
  }), { mode: 0o400 });
  await chmod(workspace, 0o700);
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = parsePdfkitResponse(run.stdout);
  assert.deepEqual(result.outline, {
    items: [
      { title: 'Direct destination', page: 1, children: [], removalLocator: null },
      { title: 'GoTo action', page: 2, children: [], removalLocator: null },
      { title: 'URI action', page: null, children: [], removalLocator: null },
      { title: 'Named action', page: null, children: [], removalLocator: null },
      { title: 'Remote GoTo action', page: null, children: [], removalLocator: null },
      { title: 'JavaScript action', page: null, children: [], removalLocator: null },
      { title: 'Ambiguous direct and URI', page: null, children: [], removalLocator: null },
    ],
    truncated: false,
  });
});

test('installed PDFKit helper marks outline item-limit truncation', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-outline-limit-'));
  const request = join(workspace, 'request.json');
  await writeFile(join(workspace, 'input.pdf'), makeMultiPagePdf(['one', 'two'], {
    outlines: [
      { title: 'First', page: 1 },
      { title: 'Second', page: 2 },
      { title: 'Bounded away', page: 1 },
    ],
  }), { mode: 0o400 });
  await writeFile(request, JSON.stringify({
    version: 1, operation: 'inspect', inputFilename: 'input.pdf',
    limits: { maxPages: 2, maxAnnotationsPerPage: 0, maxWidgetsPerPage: 0, maxOutlineDepth: 8, maxOutlineItems: 2 },
  }), { mode: 0o400 });
  await chmod(workspace, 0o700);
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(parsePdfkitResponse(run.stdout).outline, {
    items: [
      { title: 'First', page: 1, children: [], removalLocator: null },
      { title: 'Second', page: 2, children: [], removalLocator: null },
    ],
    truncated: true,
  });
});

test('installed PDFKit helper sanitizes malformed requests', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-'));
  const request = join(workspace, 'request.json');
  await writeFile(request, '{"operation":"mutate"}', { mode: 0o600 });
  await chmod(workspace, 0o700);
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  const response = JSON.parse(run.stdout);
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  assert.doesNotMatch(run.stdout, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await writeFile(request, JSON.stringify({
    version: 1, operation: 'inspect', inputFilename: 'input.pdf',
    limits: { maxPages: 101, maxAnnotationsPerPage: 0, maxWidgetsPerPage: 0, maxOutlineDepth: 0, maxOutlineItems: 0 },
  }), { mode: 0o600 });
  const limitRun = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(limitRun.stdout), { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });

  await writeFile(request, 'x'.repeat(8_193), { mode: 0o600 });
  const oversizedRun = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(oversizedRun.stdout), { version: 1, ok: false, error: { code: 'REQUEST_TOO_LARGE' } });
});

test('installed PDFKit helper rejects filename traversal and request links before inspecting', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-'));
  const request = join(workspace, 'request.json');
  await chmod(workspace, 0o700);
  const limits = { maxPages: 1, maxAnnotationsPerPage: 0, maxWidgetsPerPage: 0, maxOutlineDepth: 0, maxOutlineItems: 0 };
  for (const inputFilename of ['.', '..', '../input.pdf', 'folder/input.pdf', '/tmp/input.pdf', 'folder\\input.pdf']) {
    await writeFile(request, JSON.stringify({ version: 1, operation: 'inspect', inputFilename, limits }), { mode: 0o600 });
    const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  }

  const actual = join(workspace, 'actual.json');
  await writeFile(actual, '{}', { mode: 0o600 });
  await unlink(request);
  await symlink(actual, request);
  let run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'UNSAFE_WORKSPACE' } });
  await unlink(request);
  await link(actual, request);
  run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, ok: false, error: { code: 'UNSAFE_WORKSPACE' } });
});
