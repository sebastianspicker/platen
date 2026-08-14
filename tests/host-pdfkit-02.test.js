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

test('installed PDFKit helper rejects metadata no-ops and unsupported metadata graphs without output', { skip: !canRunIntegration() }, async () => {
  const fixtures = [
    makeTextPdf('metadata-free no-op'),
    makeMetadataSanitizationPdf({ info: '<< /Title (private) >>', catalogExtra: ' /Names << /Dests << >> >>' }),
    makeMetadataSanitizationPdf({ info: '<< /Title (private) >>', pageExtra: ' /Metadata 7 0 R' }),
    makeLocatorPdf({ catalogExtra: ' /Perms << /DocMDP << /Type /Sig >> >>' }),
  ];
  for (const source of fixtures) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-metadata-sanitize-reject-'));
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 }); await chmod(workspace, 0o700);
    const { response } = runMetadataSanitization(workspace, metadataSanitizationRequest(sourceSha256(source)));
    assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }
});

test('installed host boundary publishes only an independently validated metadata-free artifact', { skip: !canRunIntegration(), timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-host-metadata-sanitize-'));
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
    const service = new PdfKitSanitizationService({ store, poppler, adapter: pdfkit });
    const privateValues = [
      'private title', 'private author', 'private producer', 'custom private value',
    ];
    const source = makeMetadataSanitizationPdf({
      info: '<< /Title (private title) /Author (private author) /Producer (private producer) /CustomerCase (custom private value) >>',
      xmp: true,
    });
    const document = await store.createDocument({
      stream: Readable.from([source]), displayName: 'metadata-source.pdf', mediaType: 'application/pdf',
    });
    const result = await service.sanitizeMetadata(document.id, { sourceSha256: document.sha256 });
    assert.equal(result.kind, 'pdfkit-metadata-sanitization');
    assert.deepEqual(result.sanitization.removedCategories, ['document-info', 'custom-info', 'xmp']);
    assert.equal(result.evidence.nativeMetadataAbsent, true);
    assert.equal(result.evidence.popplerMetadataAbsent, true);
    assert.equal(result.evidence.popplerCustomMetadataAbsent, true);
    assert.equal(result.evidence.allPagesRendered, true);
    assert.equal(result.artifact.operation.type, 'pdfkit-metadata-sanitization');
    const retained = store.getArtifact(result.artifact.id);
    const retainedBytes = await readFile(retained.filePath);
    assert.equal(sourceSha256(retainedBytes), result.artifact.sha256);
    assert.doesNotMatch(retainedBytes.toString('latin1'), /\/Metadata\b|\/CustomerCase\b|Quartz PDFContext/u);
    assert.equal(await store.verifySource(document.id), true);
    for (const value of privateValues) {
      assert.doesNotMatch(JSON.stringify(result), new RegExp(value, 'u'));
      assert.doesNotMatch(retainedBytes.toString('latin1'), new RegExp(value, 'u'));
    }
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('installed PDFKit helper rejects unsafe protected catalog, action, signature, media, malformed, and aliased graphs', { skip: !canRunIntegration() }, async () => {
  const richMedia = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /RichMedia /Rect [72 540 272 700] /P 3 0 R /RichMediaContent 9 0 R /RichMediaSettings 10 0 R >>',
    extraObjects: [
      '<< /Assets << /Names [(remote-video) 11 0 R] >> /Configurations [12 0 R] >>',
      '<< /Activation << /Condition /PO /Configuration 12 0 R >> >>',
      '<< /Type /Filespec /FS /URL /F (https://example.invalid/auto.mp4) >>',
      '<< /Type /RichMediaConfiguration /Subtype /Video /Instances [] >>',
    ],
  });
  const twoPassiveAnnotations = makeLocalGoToAnnotationFixture({
    annotation: '<< /Type /Annot /Subtype /FreeText /Rect [72 540 272 580] /P 3 0 R /Contents (first private note) /DA (/F1 12 Tf 0 g) >>',
    annotationReferences: '8 0 R 9 0 R',
    extraObjects: [
      '<< /Type /Annot /Subtype /Square /Rect [300 540 400 640] /P 3 0 R /Contents (second private note) >>',
    ],
  });
  const fixtures = [
    { source: makeTextPdf('tagged private source', { tagged: true }) },
    { source: makeTextPdf('private action page'), replaceMediaBoxWithMalformedAA: true },
    { source: makeLocatorPdf({ withSignature: true, catalogExtra: ' /Perms << /DocMDP << /Type /Sig >> >>' }) },
    { source: richMedia },
    { source: twoPassiveAnnotations, corruptSecondAnnotation: 'alias' },
    { source: twoPassiveAnnotations, corruptSecondAnnotation: 'malformed' },
  ];
  for (const fixture of fixtures) {
    const generated = await directlyEncryptFixture(fixture.source);
    const { workspace } = generated;
    const encrypted = Buffer.from(generated.encrypted);
    if (fixture.replaceMediaBoxWithMalformedAA) {
      const marker = Buffer.from('/MediaBox', 'latin1');
      const offset = encrypted.indexOf(marker);
      assert.ok(offset >= 0);
      Buffer.from('/AA      ', 'latin1').copy(encrypted, offset);
      await writeFile(join(workspace, 'input.pdf'), encrypted, { mode: 0o600 });
    }
    if (fixture.corruptSecondAnnotation) {
      const encryptedText = encrypted.toString('latin1');
      let match = /\/Annots\s*\[\s*(\d+\s+\d+\s+R)\s+(\d+\s+\d+\s+R)/u.exec(encryptedText);
      if (!match) {
        const arrayReference = /\/Annots\s+(\d+)\s+(\d+)\s+R/u.exec(encryptedText);
        assert.ok(arrayReference);
        match = new RegExp(
          `${arrayReference[1]}\\s+${arrayReference[2]}\\s+obj\\s*\\[\\s*(\\d+\\s+\\d+\\s+R)\\s+(\\d+\\s+\\d+\\s+R)`,
          'u',
        ).exec(encryptedText);
      }
      assert.ok(match);
      const replacement = fixture.corruptSecondAnnotation === 'alias' ? match[1] : 'null';
      assert.ok(replacement.length <= match[2].length);
      const offset = match.index + match[0].lastIndexOf(match[2]);
      Buffer.from(replacement.padEnd(match[2].length), 'latin1').copy(encrypted, offset);
      await writeFile(join(workspace, 'input.pdf'), encrypted, { mode: 0o600 });
    }
    const { response, raw } = runProtectionRemoval(
      workspace, protectionRemovalRequest(sourceSha256(encrypted), 'deny-all'),
    );
    assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    assert.doesNotMatch(raw, /Owner-Pass-123|User-Pass-4567|private action page|tagged private source/u);
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), encrypted);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }
});

test('installed PDFKit helper emits source-bound opaque annotation and widget locators', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-locators-'));
  const source = makeLocatorPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const first = await runInspection(workspace);
  const second = await runInspection(workspace);
  assert.deepEqual(second.response, first.response);
  assert.equal(first.response.ok, true);
  const page = first.response.result.pages[0];
  assert.deepEqual(page.annotations.map(({ subtype, annotationIndex }) => ({ subtype, annotationIndex })), [
    { subtype: 'widget', annotationIndex: 0 }, { subtype: 'widget', annotationIndex: 1 }, { subtype: 'freeText', annotationIndex: 2 },
  ]);
  assert.deepEqual(page.widgets.map(({ fieldName, fieldType, controlKind, flags, annotationIndex }) => ({ fieldName, fieldType, controlKind, flags, annotationIndex })), [
    { fieldName: 'customer-name', fieldType: 'text', controlKind: null, flags: 0, annotationIndex: 0 },
    { fieldName: 'local-choice', fieldType: 'choice', controlKind: null, flags: 0, annotationIndex: 1 },
  ]);
  for (const annotation of page.annotations) {
    assert.deepEqual(Object.keys(annotation).sort(), ['annotationIndex', 'fingerprint', 'subtype']);
    assert.match(annotation.fingerprint, /^[0-9a-f]{64}$/);
  }
  for (const widget of page.widgets) {
    assert.deepEqual(Object.keys(widget).sort(), ['annotationIndex', 'controlKind', 'fieldName', 'fieldType', 'fingerprint', 'flags']);
    assert.match(widget.fingerprint, /^[0-9a-f]{64}$/);
  }
  assert.doesNotMatch(first.raw, /fixture annotation content must remain private/);
  assert.doesNotMatch(first.raw, /fixture widget value must remain private/);
  assert.doesNotMatch(first.raw, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await writeFile(join(workspace, 'different.pdf'), Buffer.concat([source, Buffer.from('% byte-different source\n')]), { mode: 0o600 });
  const different = await runInspection(workspace, 'different.pdf');
  assert.notDeepEqual(
    different.response.result.pages[0].annotations.map(({ fingerprint }) => fingerprint),
    first.response.result.pages[0].annotations.map(({ fingerprint }) => fingerprint),
  );
});

test('installed PDFKit helper inventories button control kinds without button values or states', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-buttons-'));
  const source = makeButtonWidgetPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const inspection = await runInspection(workspace);
  assert.equal(inspection.response.ok, true);
  assert.deepEqual(inspection.response.result.pages[0].widgets.map(({ fieldName, fieldType, controlKind, flags, annotationIndex }) => (
    { fieldName, fieldType, controlKind, flags, annotationIndex }
  )), [
    { fieldName: 'checkbox-control', fieldType: 'button', controlKind: 'checkbox', flags: 0, annotationIndex: 0 },
    { fieldName: 'radio-control', fieldType: 'button', controlKind: 'radio', flags: 32768, annotationIndex: 1 },
    { fieldName: 'push-control', fieldType: 'button', controlKind: 'push', flags: 65536, annotationIndex: 2 },
  ]);
  for (const widget of inspection.response.result.pages[0].widgets) {
    assert.deepEqual(Object.keys(widget).sort(), ['annotationIndex', 'controlKind', 'fieldName', 'fieldType', 'fingerprint', 'flags']);
    assert.match(widget.controlKind, /^(checkbox|radio|push|unknown)$/);
  }
  assert.doesNotMatch(inspection.raw, /private-(checkbox|radio|push)-state-token/);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
});

test('installed PDFKit helper inventories a custom-appearance checkbox without exposing its state names', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-custom-checkbox-'));
  const source = makeCustomCheckboxPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const inspection = await runInspection(workspace);
  assert.equal(inspection.response.ok, true);
  assert.deepEqual(inspection.response.result.pages[0].widgets.map(({ fieldName, fieldType, controlKind, flags, annotationIndex }) => (
    { fieldName, fieldType, controlKind, flags, annotationIndex }
  )), [{ fieldName: 'consent-checkbox', fieldType: 'button', controlKind: 'checkbox', flags: 0, annotationIndex: 0 }]);
  const directProbe = spawnSync('xcrun', ['swift', '-', join(workspace, 'input.pdf')], {
    input: [
      'import Foundation', 'import PDFKit',
      'let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!',
      'let widget = document.page(at: 0)!.annotations[0]',
      'print("\\(widget.buttonWidgetState.rawValue)|\\(widget.buttonWidgetStateString)|\\(widget.widgetStringValue ?? \"nil\")")',
    ].join('\n'), encoding: 'utf8',
  });
  assert.equal(directProbe.status, 0, directProbe.stderr);
  assert.equal(directProbe.stdout.trim(), '0|CheckedCustom|Off');
  const directMutationProbe = spawnSync('xcrun', ['swift', '-', join(workspace, 'input.pdf'), join(workspace, 'direct-output.pdf')], {
    input: [
      'import Foundation', 'import PDFKit', 'import AppKit', 'import CryptoKit',
      'let input = URL(fileURLWithPath: CommandLine.arguments[1])', 'let output = URL(fileURLWithPath: CommandLine.arguments[2])',
      'func renderHash(_ page: PDFPage) -> String { let bitmap = NSBitmapImageRep(data: page.thumbnail(of: CGSize(width: 256, height: 256), for: .mediaBox).tiffRepresentation!)!; return SHA256.hash(data: Data(bytes: bitmap.bitmapData!, count: bitmap.bytesPerRow * bitmap.pixelsHigh)).map { String(format: "%02x", $0) }.joined() }',
      'let document = PDFDocument(url: input)!', 'let before = renderHash(document.page(at: 0)!)', 'let widget = document.page(at: 0)!.annotations[0]',
      'widget.buttonWidgetState = PDFWidgetCellState(rawValue: 1)!',
      'try! document.dataRepresentation()!.write(to: output)',
      'let reopened = PDFDocument(url: output)!', 'let result = reopened.page(at: 0)!.annotations[0]',
      'print("\\(result.buttonWidgetState.rawValue)|\\(result.buttonWidgetStateString)|\\(result.widgetStringValue ?? \"nil\")|\\(before != renderHash(reopened.page(at: 0)!))")',
    ].join('\n'), encoding: 'utf8',
  });
  assert.equal(directMutationProbe.status, 0, directMutationProbe.stderr);
  assert.equal(directMutationProbe.stdout.trim(), '1|CheckedCustom|CheckedCustom|true');
  assert.doesNotMatch(inspection.raw, /CheckedCustom|\/Off|\/AS|\/AP/);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
});

test('installed PDFKit helper applies and privately proves custom checkbox off-to-on and on-to-off transitions', { skip: !canRunIntegration() }, async () => {
  for (const [initialState, value, expectedState, options = {}] of [
    ['Off', 'on', 'CheckedCustom'], ['CheckedCustom', 'off', 'Off'],
    ['Off', 'on', 'CheckedCustom', { catalogExtra: ' /Names << /Dests << /Names [] >> >>' }],
  ]) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-checkbox-mutate-'));
    const source = makeCustomCheckboxPdf({ initialState, ...options });
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const inspection = await runInspection(workspace);
    const checkbox = inspection.response.result.pages[0].widgets[0];
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: { page: 1, annotationIndex: checkbox.annotationIndex, fingerprint: checkbox.fingerprint, fieldType: 'button', value },
      annotationUpdate: null, annotationRemove: null, annotationProperties: null,
    }));
    assert.equal(result.response.ok, true, result.raw);
    assert.equal(result.response.result.appliedEdits, 1);
    assert.equal(Object.hasOwn(result.response.result, 'inspection'), false);
    assert.doesNotMatch(result.raw, /CheckedCustom|\/Off|\/AS|\/AP/);
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
    const output = (await readFile(join(workspace, 'output.pdf'))).toString('latin1');
    assert.match(output, new RegExp(`/AS\\s*/${expectedState}(?:\\s|/|>)`));
    assert.match(output, new RegExp(`/V\\s*/${expectedState}(?:\\s|/|>)`));
  }
});

test('installed PDFKit helper rejects unsafe, ambiguous, malformed, and no-op checkbox requests', { skip: !canRunIntegration() }, async () => {
  const rejectedFixtures = [
    { flags: 1 << 15 }, { flags: 1 << 16 }, { sharedFieldName: true }, { fieldName: '' }, { flags: 1 },
    { withAction: true }, { includeOff: false }, { includeOn: false },
    { catalogExtra: ' /OpenAction << /S /URI /URI (https://example.invalid) >>' }, { acroFormExtra: ' /XFA (prohibited)' },
    { acroFormExtra: ' /CO []' }, { hiddenSignature: true },
    { pageExtra: ' /AA << /O << /S /URI /URI (https://example.invalid) >> >>' },
    { catalogExtra: ' /Perms << /DocMDP << /Type /Sig >> >>' },
    { catalogExtra: ' /Names << /Renditions << >> >>' },
    { catalogExtra: ' /Outlines << /First << /Title (unsafe) /A << /S /URI /URI (https://example.invalid) >> >> >>' },
    { inheritedParentFlags: 1 << 14, initialState: 'CheckedCustom' },
    { orphanField: true }, { duplicateFieldReference: true },
  ];
  for (const options of rejectedFixtures) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-checkbox-reject-'));
    const source = makeCustomCheckboxPdf(options);
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const inspection = await runInspection(workspace);
    const checkbox = inspection.response.result.pages[0].widgets[0];
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: { page: 1, annotationIndex: checkbox.annotationIndex, fingerprint: checkbox.fingerprint, fieldType: 'button', value: 'on' },
      annotationUpdate: null, annotationRemove: null, annotationProperties: null,
    }));
    assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } }, JSON.stringify(options));
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')));
  }

  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-checkbox-noop-'));
  const source = makeCustomCheckboxPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const checkbox = (await runInspection(workspace)).response.result.pages[0].widgets[0];
  for (const value of ['off', 'enabled', 'CheckedCustom']) {
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: { page: 1, annotationIndex: checkbox.annotationIndex, fingerprint: checkbox.fingerprint, fieldType: 'button', value },
      annotationUpdate: null, annotationRemove: null, annotationProperties: null,
    }));
    assert.deepEqual(result.response, { version: 1, ok: false, error: { code: value === 'off' ? 'MUTATION_FAILED' : 'INVALID_REQUEST' } });
  }
  const changed = Buffer.concat([source, Buffer.from('% stale checkbox locator\n')]);
  await writeFile(join(workspace, 'input.pdf'), changed, { mode: 0o600 });
  const stale = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(changed), {
    formFill: { page: 1, annotationIndex: checkbox.annotationIndex, fingerprint: checkbox.fingerprint, fieldType: 'button', value: 'on' },
    annotationUpdate: null, annotationRemove: null, annotationProperties: null,
  }));
  assert.deepEqual(stale.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
});

test('installed PDFKit helper canonically selects first, middle, and last radio widgets without exposing group state', { skip: !canRunIntegration() }, async () => {
  const cases = [
    { selectedIndex: 1, targetIndex: 0, targetPages: [1, 1, 2] },
    { selectedIndex: 0, targetIndex: 1, targetPages: [1, 1, 2] },
    { selectedIndex: null, targetIndex: 2, targetPages: [1, 1, 2], flags: (1 << 1) | (1 << 14) },
    { selectedIndex: 0, targetIndex: 2, targetPages: [1, 2, 2] },
  ];
  for (const options of cases) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-radio-select-'));
    const source = makeCanonicalRadioPdf(options);
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const inspection = await runInspection(workspace);
    const radio = inspection.response.result.pages[options.targetPages[options.targetIndex] - 1].widgets
      .filter((widget) => widget.controlKind === 'radio')
      .find((widget) => widget.annotationIndex === (options.targetPages[options.targetIndex] === 1
        ? options.targetPages.slice(0, options.targetIndex).filter((page) => page === 1).length
        : options.targetPages.slice(0, options.targetIndex).filter((page) => page === 2).length));
    assert.ok(radio, JSON.stringify(options));
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: { page: options.targetPages[options.targetIndex], annotationIndex: radio.annotationIndex, fingerprint: radio.fingerprint, fieldType: 'button', value: 'select' },
      annotationUpdate: null, annotationRemove: null, annotationProperties: null,
    }));
    assert.equal(result.response.ok, true, `${JSON.stringify(options)} ${result.raw}`);
    assert.equal(result.response.result.appliedEdits, 1);
    assert.equal(Object.hasOwn(result.response.result, 'inspection'), false);
    assert.doesNotMatch(result.raw, /private-radio-group-name/);
    assert.doesNotMatch(result.raw, /private-radio-(alpha|bravo|charlie)|\/AP|\/AS|\/V/);
    const output = (await readFile(join(workspace, 'output.pdf'))).toString('latin1');
    assert.match(output, new RegExp(`/V\\s*/private-radio-${['alpha', 'bravo', 'charlie'][options.targetIndex]}(?:\\s|/|>)`));
  }
});

test('installed PDFKit helper rejects non-canonical, action-bearing, and no-op radio selections', { skip: !canRunIntegration() }, async () => {
  const rejected = [
    { flags: 1 }, { flags: 1 << 16 }, { flags: 1 << 25 }, { withAction: true }, { duplicateKid: true },
    { selectedIndex: 0 },
  ];
  for (const options of rejected) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-radio-reject-'));
    const source = makeCanonicalRadioPdf(options);
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const inspection = await runInspection(workspace);
    const target = inspection.response.result.pages[0].widgets.find((widget) => widget.controlKind === 'radio');
    const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
      formFill: { page: 1, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint, fieldType: 'button', value: 'select' },
      annotationUpdate: null, annotationRemove: null, annotationProperties: null,
    }));
    assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } }, JSON.stringify(options));
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  }
});

test('installed PDFKit helper clears a source-bound hand-built choice widget and privately proves the render change', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-choice-clear-'));
  const source = makeLocatorPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const inspection = await runInspection(workspace);
  const choice = inspection.response.result.pages[0].widgets.find((widget) => widget.fieldType === 'choice');
  const result = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), {
    formFill: { page: 1, annotationIndex: choice.annotationIndex, fingerprint: choice.fingerprint, fieldType: 'choice', value: '' },
    annotationUpdate: null, annotationRemove: null, annotationProperties: null,
  }));
  assert.equal(result.response.ok, true, result.raw);
  assert.equal(result.response.result.appliedEdits, 1);
  assert.equal(Object.hasOwn(result.response.result, 'inspection'), false);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.notDeepEqual(await readFile(join(workspace, 'output.pdf')), source);
  assert.doesNotMatch(result.raw, /one|two|\/AP|\/Opt|fixture widget value must remain private/);
});
