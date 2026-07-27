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

test('installed PDFKit helper emits a bounded read-only inspection inventory', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-'));
  const request = join(workspace, 'request.json');
  await writeFile(join(workspace, 'input.pdf'), makeTextPdf('this text must not appear in the response'), { mode: 0o600 });
  await writeFile(request, JSON.stringify({
    version: 1, operation: 'inspect', inputFilename: 'input.pdf',
    limits: { maxPages: 10, maxAnnotationsPerPage: 10, maxWidgetsPerPage: 10, maxOutlineDepth: 8, maxOutlineItems: 10 },
  }), { mode: 0o600 });
  await chmod(workspace, 0o700);
  const run = spawnSync(productPath, ['--request', request], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const response = JSON.parse(run.stdout);
  assert.equal(run.stdout.endsWith('\n'), false);
  assert.equal(parsePdfkitResponse(run.stdout).document.pageCount, 1);
  assert.equal(response.ok, true);
  assert.equal(response.result.document.pageCount, 1);
  assert.deepEqual(Object.keys(response.result.document.permissions).sort(), [
    'assembly', 'changes', 'commenting', 'contentAccessibility', 'copying', 'formFieldEntry', 'printing', 'status',
  ]);
  assert.match(response.result.document.permissions.status, /^(none|user|owner|unknown)$/);
  assert.deepEqual(Object.keys(response.result.metadata).sort(), [
    'author', 'creationDate', 'creator', 'keywords', 'modificationDate', 'producer', 'subject', 'title',
  ]);
  assert.doesNotMatch(run.stdout, /this text must not appear in the response/);
});

test('installed PDFKit helper inventories logical labels, inert links, and optional-content groups', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-navigation-'));
  const source = makeNavigationPdf();
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const { response, raw } = await runInspection(workspace);
  assert.equal(response.ok, true);
  const inventory = parsePdfkitResponse(raw);
  assert.deepEqual(inventory.pages.map(({ index, label }) => ({ index, label })), [
    { index: 1, label: 'Front-i' }, { index: 2, label: 'Body-3' },
  ]);
  assert.deepEqual(inventory.pageLabels, {
    present: true,
    items: [{ page: 1, label: 'Front-i' }, { page: 2, label: 'Body-3' }],
    truncated: false,
  });
  assert.deepEqual(inventory.optionalContent, {
    present: true, groupCount: 1, groups: [{ index: 0, name: 'Review layer', defaultVisible: true }],
    groupsTruncated: false, defaultConfigurationPresent: true,
  });
  assert.deepEqual(inventory.pages[0].links.map(({ annotationIndex, kind, targetPage, target, remotePage }) => ({
    annotationIndex, kind, targetPage, target, remotePage,
  })), [
    { annotationIndex: 0, kind: 'goTo', targetPage: 2, target: null, remotePage: null },
    { annotationIndex: 1, kind: 'url', targetPage: null, target: 'https://example.test/inert', remotePage: null },
  ]);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
});

test('installed PDFKit helper preserves exact bounded logical labels and rejects longer values', { skip: !canRunIntegration() }, async () => {
  const acceptedPrefixes = [
    'a'.repeat(1_023),
    `${'é'.repeat(510)}aaa`,
  ];
  for (const prefix of acceptedPrefixes) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-label-boundary-'));
    const source = makeNavigationPdf({ frontPrefix: prefix });
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const { response, raw } = await runInspection(workspace);
    assert.equal(response.ok, true);
    const label = parsePdfkitResponse(raw).pageLabels.items[0].label;
    assert.equal(label, `${prefix}i`);
    assert.equal(Buffer.byteLength(label, 'utf8'), 1_024);
  }

  const rejectedPrefixes = [
    'a'.repeat(1_024),
    'é'.repeat(512),
  ];
  for (const prefix of rejectedPrefixes) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-label-overflow-'));
    await writeFile(join(workspace, 'input.pdf'), makeNavigationPdf({ frontPrefix: prefix }), { mode: 0o600 });
    await chmod(workspace, 0o700);
    const { response } = await runInspection(workspace);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: 'RESPONSE_TOO_LARGE' } });
  }
});

test('installed PDFKit helper protects plain PDFs through stdin without exposing passwords', { skip: !canRunIntegration() }, async () => {
  for (const [profile, effectivePermissionMask, effectivePermissions, pdfPermissionValue] of [
    ['accessibility-only', 32, ['contentAccessibility'], -3392],
    ['copy-accessibility', 48, ['copying', 'contentAccessibility'], -3376],
    ['deny-all', 0, [], -3904],
    ['print-only', 3, ['printing'], -1852],
  ]) {
    for (let repetition = 0; repetition < 2; repetition += 1) {
      const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-'));
      const source = makeTextPdf('protection fixture content must remain private');
      await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
      await chmod(workspace, 0o700);
      const request = protectionRequest(sourceSha256(source), profile);
      const { response, raw } = runProtection(workspace, request);
      assert.equal(response.ok, true);
      assert.deepEqual(Object.keys(response.result).sort(), [
        'effectivePermissionMask', 'effectivePermissions', 'operation', 'outputSha256', 'pageCount', 'profile',
        'schema', 'sourceSha256', 'structuralSummary', 'version',
      ]);
      assert.equal(response.result.schema, 'pdfkit-protection-receipt-v1');
      assert.equal(response.result.version, 1);
      assert.equal(response.result.operation, 'protect');
      assert.equal(response.result.profile, profile);
      assert.equal(response.result.sourceSha256, sourceSha256(source));
      assert.match(response.result.outputSha256, /^[0-9a-f]{64}$/);
      assert.equal(response.result.effectivePermissionMask, effectivePermissionMask);
      assert.deepEqual(response.result.effectivePermissions, effectivePermissions);
      assert.equal(response.result.pageCount, 1);
      assert.deepEqual(response.result.structuralSummary, {
        pageRotations: [0], annotationCounts: [0], annotationSubtypes: [[]],
      });
      assert.doesNotMatch(raw, /Owner-Pass-123|User-Pass-4567|protection fixture content must remain private/);
      assert.doesNotMatch(raw, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
      const output = await readFile(join(workspace, 'output.pdf'));
      const outputText = output.toString('latin1');
      assert.equal(sourceSha256(output), response.result.outputSha256);
      assert.match(outputText, /\/Encrypt/);
      assert.match(outputText, /\/Filter \/Standard \/V 4 \/R 4 \/Length 128/);
      assert.match(outputText, /\/CFM \/AESV2/);
      assert.match(outputText, new RegExp(`/P ${pdfPermissionValue}(?:\\s|>>)`));
      assert.notDeepEqual(output, source);
      assert.equal((await stat(join(workspace, 'output.pdf'))).mode & 0o777, 0o600);
      await assert.rejects(readFile(join(workspace, 'request.json')));
    }
  }
});

test('installed PDFKit helper preserves private metadata, outlines, text, boxes, and renders during protection', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-'));
  await writeFile(join(workspace, 'input.pdf'), makeMultiPagePdf(['first protected page', 'second protected page'], {
    outlines: [{ title: 'First chapter', page: 1 }, { title: 'Second chapter', page: 2 }],
  }), { mode: 0o600 });
  await chmod(workspace, 0o700);
  const mutation = await runMutation(workspace, {
    ...emptyMutation(), metadata: { title: 'Private title', author: 'Private author', subject: 'Private subject', keywords: 'private, keywords' },
  });
  assert.equal(mutation.ok, true);
  const derivedSource = await readFile(join(workspace, 'output.pdf'));
  await writeFile(join(workspace, 'input.pdf'), derivedSource, { mode: 0o600 });
  await unlink(join(workspace, 'output.pdf'));
  await unlink(join(workspace, 'request.json'));
  const result = runProtection(workspace, protectionRequest(sourceSha256(derivedSource)));
  assert.equal(result.response.ok, true);
  assert.equal(result.response.result.pageCount, 2);
  assert.deepEqual(result.response.result.structuralSummary.annotationCounts, [0, 0]);
  assert.doesNotMatch(result.raw, /Private title|Private author|Private subject|private, keywords/);
});

test('installed PDFKit helper rejects invalid or unsafe protection requests without persisting passwords', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-'));
  const source = makeTextPdf('protection source');
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const invalid = protectionRequest(sourceSha256(source));
  invalid.protection.userPassword = 'short';
  let result = runProtection(workspace, invalid);
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  assert.doesNotMatch(result.raw, /short|Owner-Pass-123/);

  const ownerClassificationGap = protectionRequest(sourceSha256(source));
  ownerClassificationGap.protection.userPassword = 'A'.repeat(17);
  result = runProtection(workspace, ownerClassificationGap);
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });

  const unsupported = protectionRequest(sourceSha256(source), 'comment-form');
  result = runProtection(workspace, unsupported);
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  assert.doesNotMatch(result.raw, /Owner-Pass-123|User-Pass-4567/);

  result = runProtection(workspace, protectionRequest('a'.repeat(64)));
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });

  const formWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-'));
  const formSource = makeLocatorPdf();
  await writeFile(join(formWorkspace, 'input.pdf'), formSource, { mode: 0o600 });
  await chmod(formWorkspace, 0o700);
  result = runProtection(formWorkspace, protectionRequest(sourceSha256(formSource)));
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });

  const attachmentWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-'));
  const attachmentSource = makeMultiPagePdf(['attachment source'], { attachment: { name: 'private.txt', content: 'private attachment' } });
  await writeFile(join(attachmentWorkspace, 'input.pdf'), attachmentSource, { mode: 0o600 });
  await chmod(attachmentWorkspace, 0o700);
  result = runProtection(attachmentWorkspace, protectionRequest(sourceSha256(attachmentSource)));
  assert.deepEqual(result.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
});

test('installed PDFKit helper removes all four protection profiles through a fresh private document', { skip: !canRunIntegration() }, async () => {
  for (const profile of ['accessibility-only', 'copy-accessibility', 'deny-all', 'print-only']) {
    const semanticEvidence = [];
    for (let repetition = 0; repetition < 2; repetition += 1) {
      const protectWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-for-removal-'));
      const plaintext = makeTextPdf(`private removal fixture ${profile} ${repetition}`);
      await writeFile(join(protectWorkspace, 'input.pdf'), plaintext, { mode: 0o600 });
      await chmod(protectWorkspace, 0o700);
      const protectedResult = runProtection(protectWorkspace, protectionRequest(sourceSha256(plaintext), profile));
      assert.equal(protectedResult.response.ok, true, protectedResult.raw);
      const encrypted = await readFile(join(protectWorkspace, 'output.pdf'));

      const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-remove-protection-'));
      await writeFile(join(workspace, 'input.pdf'), encrypted, { mode: 0o600 });
      await chmod(workspace, 0o700);
      const { response, raw } = runProtectionRemoval(
        workspace, protectionRemovalRequest(sourceSha256(encrypted), profile),
      );
      assert.equal(response.ok, true, raw);
      assert.deepEqual(Object.keys(response.result).sort(), [
        'encryptionRemoved', 'operation', 'outputSha256', 'ownerAuthorizationVerified', 'pageCount',
        'reopenVerified', 'schema', 'sourceProfile', 'sourceSha256', 'structuralSummary', 'version',
      ]);
      assert.deepEqual({ ...response.result, sourceSha256: 'digest', outputSha256: 'digest' }, {
        schema: 'pdfkit-deprotection-receipt-v1', version: 1, operation: 'removeProtection',
        sourceProfile: profile, sourceSha256: 'digest', outputSha256: 'digest',
        pageCount: 1, structuralSummary: {
          pageRotations: [0], annotationCounts: [0], annotationSubtypes: [[]],
        },
        ownerAuthorizationVerified: true, encryptionRemoved: true, reopenVerified: true,
      });
      assert.equal(response.result.sourceSha256, sourceSha256(encrypted));
      assert.match(response.result.outputSha256, /^[0-9a-f]{64}$/u);
      assert.notEqual(response.result.outputSha256, response.result.sourceSha256);
      assert.doesNotMatch(raw, /Owner-Pass-123|User-Pass-4567|private removal fixture|input\.pdf|output\.pdf/u);
      assert.doesNotMatch(raw, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(await readFile(join(workspace, 'input.pdf')), encrypted);
      const output = await readFile(join(workspace, 'output.pdf'));
      assert.equal(sourceSha256(output), response.result.outputSha256);
      assert.notDeepEqual(output, encrypted);
      assert.doesNotMatch(output.toString('latin1'), /\/Encrypt\b/u);
      assert.equal((await stat(join(workspace, 'output.pdf'))).mode & 0o777, 0o600);
      semanticEvidence.push({
        pageCount: response.result.pageCount,
        structuralSummary: response.result.structuralSummary,
        ownerAuthorizationVerified: response.result.ownerAuthorizationVerified,
        encryptionRemoved: response.result.encryptionRemoved,
        reopenVerified: response.result.reopenVerified,
      });
    }
    assert.deepEqual(semanticEvidence[1], semanticEvidence[0]);
  }
});

test('installed PDFKit helper requires exact owner authorization before removal and accepts bounded interior spaces', { skip: !canRunIntegration() }, async () => {
  const protectWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-protect-spaced-passwords-'));
  const plaintext = makeTextPdf('private spaced-password removal fixture');
  await writeFile(join(protectWorkspace, 'input.pdf'), plaintext, { mode: 0o600 });
  await chmod(protectWorkspace, 0o700);
  const protectRequest = protectionRequest(sourceSha256(plaintext));
  protectRequest.protection.ownerPassword = 'Owner Pass 123';
  protectRequest.protection.userPassword = 'User Pass 123456';
  const protectedResult = runProtection(protectWorkspace, protectRequest);
  assert.equal(protectedResult.response.ok, true, protectedResult.raw);
  const encrypted = await readFile(join(protectWorkspace, 'output.pdf'));

  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-remove-protection-auth-'));
  await writeFile(join(workspace, 'input.pdf'), encrypted, { mode: 0o600 });
  await chmod(workspace, 0o700);
  for (const [password, code] of [
    ['User Pass 123456', 'MUTATION_FAILED'],
    ['Wrong Pass 123', 'MUTATION_FAILED'],
    [' Owner Pass 123', 'INVALID_REQUEST'],
  ]) {
    const { response, raw } = runProtectionRemoval(
      workspace, protectionRemovalRequest(sourceSha256(encrypted), 'accessibility-only', password),
    );
    assert.deepEqual(response, { version: 1, ok: false, error: { code } });
    assert.doesNotMatch(raw, /Owner Pass 123|User Pass 123456|Wrong Pass 123|private spaced-password/u);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), encrypted);
  }
  const mismatchedProfile = runProtectionRemoval(
    workspace, protectionRemovalRequest(sourceSha256(encrypted), 'print-only', 'Owner Pass 123'),
  );
  assert.deepEqual(mismatchedProfile.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });

  const owner = runProtectionRemoval(
    workspace, protectionRemovalRequest(sourceSha256(encrypted), 'accessibility-only', 'Owner Pass 123'),
  );
  assert.equal(owner.response.ok, true, owner.raw);
  assert.doesNotMatch(owner.raw, /Owner Pass 123|private spaced-password/u);
});

test('installed PDFKit helper retains private metadata, outlines, page geometry, text, and renders during removal', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-remove-protection-preservation-'));
  const rawSource = makeMultiPagePdf(['first private removal page', 'second private removal page'], {
    outlines: [{ title: 'Private first chapter', page: 1 }, { title: 'Private second chapter', page: 2, action: 'goTo' }],
    rotations: [0, 90], cropBoxes: [[10, 20, 500, 740], [20, 30, 520, 750]],
  });
  const source = Buffer.from(rawSource);
  const pageMode = Buffer.from('/PageMode /UseOutlines', 'latin1');
  const pageModeOffset = source.indexOf(pageMode);
  assert.ok(pageModeOffset >= 0);
  source.fill(0x20, pageModeOffset, pageModeOffset + pageMode.length);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const mutation = await runMutation(workspace, {
    ...emptyMutation(),
    metadata: {
      title: 'Private removal title', author: 'Private removal author',
      subject: 'Private removal subject', keywords: 'private, removal, keywords',
    },
  });
  assert.equal(mutation.ok, true);
  const derivedSource = await readFile(join(workspace, 'output.pdf'));
  const beforeInspection = await runInspection(workspace, 'output.pdf');
  const beforeHashes = nativeContentHashes(join(workspace, 'output.pdf'));
  await writeFile(join(workspace, 'input.pdf'), derivedSource, { mode: 0o600 });
  await unlink(join(workspace, 'output.pdf'));
  await unlink(join(workspace, 'request.json'));
  const protectedResult = runProtection(workspace, protectionRequest(sourceSha256(derivedSource), 'copy-accessibility'));
  assert.equal(protectedResult.response.ok, true, protectedResult.raw);
  const encrypted = await readFile(join(workspace, 'output.pdf'));

  const removalWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-remove-protection-preserved-'));
  await writeFile(join(removalWorkspace, 'input.pdf'), encrypted, { mode: 0o600 });
  await chmod(removalWorkspace, 0o700);
  const removed = runProtectionRemoval(
    removalWorkspace, protectionRemovalRequest(sourceSha256(encrypted), 'copy-accessibility'),
  );
  assert.equal(removed.response.ok, true, removed.raw);
  assert.doesNotMatch(removed.raw, /Private removal|private, removal, keywords|first private removal page/u);
  const afterInspection = await runInspection(removalWorkspace, 'output.pdf');
  const afterHashes = nativeContentHashes(join(removalWorkspace, 'output.pdf'));
  assert.deepEqual(afterHashes, beforeHashes);
  assert.deepEqual(afterInspection.response.result.outline, beforeInspection.response.result.outline);
  assert.deepEqual(
    afterInspection.response.result.pages.map(({ rotation, boxes, annotations }) => ({
      rotation, boxes, annotations: annotations.map(({ subtype }) => subtype),
    })),
    beforeInspection.response.result.pages.map(({ rotation, boxes, annotations }) => ({
      rotation, boxes, annotations: annotations.map(({ subtype }) => subtype),
    })),
  );
  for (const key of ['title', 'author', 'subject', 'creator', 'keywords']) {
    assert.equal(afterInspection.response.result.metadata[key], beforeInspection.response.result.metadata[key]);
  }
});

test('installed PDFKit helper removes Info, custom Info, and XMP without retaining injected writer metadata', { skip: !canRunIntegration() }, async () => {
  const fullInfo = '<< /Title (private title) /Author (private author) /Subject (private subject) /Creator (private creator) /Producer (private producer) /CreationDate (D:20260101010101Z) /ModDate (D:20260202020202Z) /Keywords (private, keywords) /CustomerCase (custom private value) >>';
  for (const [label, source, observedCategories] of [
    ['info', makeMetadataSanitizationPdf({ info: fullInfo }), ['document-info', 'custom-info']],
    ['xmp', makeMetadataSanitizationPdf({ xmp: true }), ['xmp']],
    ['combined', makeMetadataSanitizationPdf({ info: fullInfo, xmp: true }), ['document-info', 'custom-info', 'xmp']],
  ]) {
    const workspace = await mkdtemp(join(tmpdir(), `pdfkit-helper-metadata-sanitize-${label}-`));
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 }); await chmod(workspace, 0o700);
    const beforeHashes = nativeContentHashes(join(workspace, 'input.pdf'));
    const { response, raw } = runMetadataSanitization(workspace, metadataSanitizationRequest(sourceSha256(source)));
    assert.equal(response.ok, true, raw);
    assert.deepEqual(Object.keys(response.result).sort(), [
      'contentSnapshotMatched', 'freshDocumentCopy', 'metadataAbsent', 'observedCategories', 'operation',
      'outputSha256', 'pageCount', 'reopenVerified', 'schema', 'sourceSha256', 'version',
    ]);
    assert.deepEqual({ ...response.result, sourceSha256: 'digest', outputSha256: 'digest' }, {
      schema: 'pdfkit-metadata-sanitization-receipt-v1', version: 1, operation: 'sanitizeMetadata', sourceSha256: 'digest',
      outputSha256: 'digest', pageCount: 1, observedCategories, freshDocumentCopy: true, metadataAbsent: true,
      contentSnapshotMatched: true, reopenVerified: true,
    });
    assert.doesNotMatch(raw, /private title|private author|private subject|private creator|private producer|custom private value/u);
    const output = await readFile(join(workspace, 'output.pdf'));
    assert.equal(sourceSha256(output), response.result.outputSha256); assert.deepEqual(nativeContentHashes(join(workspace, 'output.pdf')), beforeHashes);
    const inspection = await runInspection(workspace, 'output.pdf'); assert.equal(inspection.response.ok, true);
    assert.deepEqual(inspection.response.result.metadata, {
      title: null, author: null, subject: null, creator: null, producer: null,
      creationDate: null, modificationDate: null, keywords: null,
    });
    assert.doesNotMatch(output.toString('latin1'), /\/Metadata\b|\/CustomerCase\b|Quartz PDFContext/u);
    assert.equal((await stat(join(workspace, 'output.pdf'))).mode & 0o777, 0o600);
  }
});
