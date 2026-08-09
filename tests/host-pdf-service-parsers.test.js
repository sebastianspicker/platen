import test from 'node:test';
import * as fixture from './support/host-pdf-service-fixture.js';

const {
  access, assert, assertWorkspaceQuota, convertSignatureContentsToDer, createReadStream,
  decodePng, DocumentStore, EngineRegistry, encodeRgbaPng, execFileAsync,
  executeOfflineSignatureInspection, HostError, join, link, makeInspectionPdf,
  makeMultiPagePdf, makePdfsigOutput, makeTextPdf, measureWorkspaceBytes, mkdir,
  mkdtemp, nativePackageRoot, OcrImageAdapter, parseAttachments, parseCustomMetadata,
  parseDocumentUrls, parseFonts, parseImages, parseNamedDestinations, parsePageBoxes,
  parsePageDimensions, parsePdfInfo, parseSignatures, parseTaggedStructure,
  parseTesseractLanguages, parseTesseractTsv, parseTextPages, PdfService,
  POPPLER_DESTINATION_HEADER, PopplerAdapter, projectRoot, readFile, Readable, rename,
  rm, SignatureTrustAdapter, stageSignatureTrustHelper, symlink, TesseractAdapter, tmpdir,
  validateAltoEvidence, validateOcrBatchManifest, validateOcrDocumentResult,
  validateOcrLayoutResult, validatePages, verifyStagedSignatureTrustHelper, writeFile,
} = fixture;

test('Poppler output parsers normalize document evidence', () => {
  const info = parsePdfInfo('Title: Example\nPages: 2\nTagged: yes\nEncrypted: no\nPage size: 612 x 792 pts\nPDF version: 1.7\n');
  assert.equal(info.pageCount, 2);
  assert.equal(info.title, 'Example');
  assert.equal(info.tagged, 'yes');
  assert.equal(info.pdfVersion, '1.7');
  assert.deepEqual(parsePageDimensions('Page    2 size: 612 x 792 pts (letter)\n', 2), {
    page: 2, widthPoints: 612, heightPoints: 792,
  });
  assert.equal(parsePageDimensions('Page 2 size: 612 x 792 pts\nPage 2 rot: 270\n', 2).rotation, 270);
  assert.throws(
    () => parsePageDimensions('Page 2 size: 612 x 792 pts\nPage 2 rot: 45\n', 2),
    { code: 'INVALID_ENGINE_OUTPUT', status: 502 },
  );

  assert.deepEqual(parseTextPages('first\fsecond\f', 2), [
    { page: 1, text: 'first' },
    { page: 2, text: 'second' },
  ]);
  assert.equal(parseFonts('name                                 type              encoding         emb sub uni object ID\n------------------------------------ ----------------- ---------------- --- --- --- ---------\nHelvetica                            Type 1            Custom           no  no  no       4  0\n').length, 1);
  const image = parseImages('page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n   1     0 image     100   200  rgb     3   8  image  no         8  0    72    72 120B 1%\n')[0];
  assert.equal(image.width, 100);
  assert.equal(image.number, 0);
  assert.equal(image.objectId, 8);
  assert.equal(image.generation, 0);
  const unknownPpi = parseImages('page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n   1     0 image     100   200  rgb     3   8  image  no         8  0     0     - 120B 1%\n')[0];
  assert.equal(unknownPpi.xPpi, null);
  assert.equal(unknownPpi.yPpi, null);
  assert.throws(
    () => parseFonts('name type encoding emb sub uni object ID\nFakeFont Type 1 WinAnsi maybe no no 8 0\n'),
    { code: 'INVALID_ENGINE_OUTPUT', status: 502 },
  );
  assert.throws(
    () => parseImages('page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n1 0 image 100 200 rgb 3 8 image no 8 0 not-a-ppi 72 120B 1%\n'),
    { code: 'INVALID_ENGINE_OUTPUT', status: 502 },
  );
  assert.deepEqual(parseAttachments('2 embedded files\n1: note.txt\n2: data.csv\n').map(({ name }) => name), ['note.txt', 'data.csv']);
  assert.equal(parseSignatures("File 'plain.pdf' does not contain any signatures").count, 0);
  assert.deepEqual(parseTesseractLanguages('List of available languages (2):\neng\ndeu\n'), ['deu', 'eng']);
  assert.deepEqual(parseTesseractTsv('level\tpage_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t10\t20\t30\t10\t42.5\tword\n', 1)[0], {
    page: 1, text: 'word', confidence: 42.5, left: 10, top: 20, width: 30, height: 10,
  });
  assert.deepEqual(parsePageBoxes(
    'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 18 18 594 774\n',
    { firstPage: 1, lastPage: 1 },
  )[0].boxes.cropBox, {
    left: 18, bottom: 18, right: 594, top: 774, width: 576, height: 756,
  });
  assert.deepEqual(parseCustomMetadata('Department: Prepress\nDepartment: Local\n'), [
    { name: 'Department', value: 'Prepress' }, { name: 'Department', value: 'Local' },
  ]);
  assert.deepEqual(parseNamedDestinations(`${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "chapter-one"\n`, { pageCount: 2 }), {
    items: [{ page: 1, destination: '[ XYZ 0 792 0 ]', name: 'chapter-one' }], truncated: false,
  });
  assert.deepEqual(parseDocumentUrls('Page Type URL\n1 URI https://example.test/local\n')[0], {
    page: 1, type: 'URI', url: 'https://example.test/local',
  });
  assert.deepEqual(parseTaggedStructure('Document\n  P\n    Span\n').lines.map(({ depth }) => depth), [0, 2, 4]);
});

test('resource listings parse stdout only and reject malformed Poppler resource rows', async () => {
  const documentId = 'resource-document';
  const sourceSha256 = 'a'.repeat(64);
  const store = {
    getDocument(id) { assert.equal(id, documentId); return { sha256: sourceSha256 }; },
    getSourcePath(id) { assert.equal(id, documentId); return '/private/source.pdf'; },
    async verifySource(id) { assert.equal(id, documentId); return true; },
  };
  const stdout = [
    'name                                 type              encoding         emb sub uni object ID',
    '------------------------------------ ----------------- ---------------- --- --- --- ---------',
    'Helvetica                            Type 1            WinAnsi          yes  no  yes      4  0',
  ].join('\n');
  const service = new PdfService({
    store, registry: {},
    adapter: { async execute(operation) {
      assert.equal(operation, 'listFonts');
      return {
        stdout,
        stderr: 'warning: font cache changed\nFakeFont                            Type 1            WinAnsi          yes no  yes      9  0\n',
      };
    } },
  });
  const fonts = await service.listFonts(documentId);
  assert.deepEqual(fonts, [{
    name: 'Helvetica', type: 'Type 1', encoding: 'WinAnsi', embedded: 'yes',
    subset: 'no', unicode: 'yes', sourceSha256,
  }]);
});

test('named destination parser fails closed and retains only its bounded page-level inventory', () => {
  const many = [POPPLER_DESTINATION_HEADER, ...Array.from({ length: 201 }, (_, index) => `${(index % 2) + 1} [ XYZ 0 792 0 ] "destination-${index}"`)].join('\n');
  const parsed = parseNamedDestinations(many, { pageCount: 2 });
  assert.equal(parsed.items.length, 200);
  assert.equal(parsed.truncated, true);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.items), true);
  assert.equal(Object.isFrozen(parsed.items[0]), true);
  assert.equal(parseNamedDestinations(`${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "chapter\\"one"\n`, { pageCount: 1 }).items[0].name, 'chapter\\"one');
  for (const output of [
    '', 'Destinations\n', `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ]`,
    `${POPPLER_DESTINATION_HEADER}\n---------------------`,
    `${POPPLER_DESTINATION_HEADER}\n\n1 [ XYZ 0 792 0 ] "bad"`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "bad"\n\n`,
    `${POPPLER_DESTINATION_HEADER}\n0 [ XYZ 0 792 0 ] "bad"`,
    `${POPPLER_DESTINATION_HEADER}\n2 [ XYZ 0 792 0 ] "bad"`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "bad"\u0000`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "bad"\u007f`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "bad"\u0085`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ 0 792 0 ] "bad"\t`,
    `${POPPLER_DESTINATION_HEADER}\n1     "bad"`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ ] ""`,
    `${POPPLER_DESTINATION_HEADER}\n1 ${'x'.repeat(4097)} "bad"`,
    `${POPPLER_DESTINATION_HEADER}\n1 [ XYZ ] "${'x'.repeat(1025)}"`,
  ]) assert.throws(() => parseNamedDestinations(output, { pageCount: 1 }), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
  for (const output of [null, undefined, 1, {}, Buffer.from(POPPLER_DESTINATION_HEADER)]) {
    assert.throws(() => parseNamedDestinations(output, { pageCount: 1 }), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
  }
  const malformedAfterCap = [
    POPPLER_DESTINATION_HEADER,
    ...Array.from({ length: 200 }, (_, index) => `1 [ XYZ 0 792 0 ] "destination-${index}"`),
    'malformed-row-201',
  ].join('\n');
  assert.throws(() => parseNamedDestinations(malformedAfterCap, { pageCount: 1 }), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
});

test('structural inspection brackets page-count and structure reads with source verification', async () => {
  const documentId = 'document';
  const outputs = {
    inspect: 'Pages: 1\n',
    inspectPageBoxes: 'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 0 0 612 792\n',
    inspectMetadata: '',
    inspectCustomMetadata: '',
    inspectDestinations: `${POPPLER_DESTINATION_HEADER}\n`,
    inspectUrls: 'Page Type URL\n',
    inspectStructure: '',
  };
  const events = [];
  const store = {
    getDocument(id) { assert.equal(id, documentId); return { sha256: 'a'.repeat(64) }; },
    getSourcePath(id) { assert.equal(id, documentId); return '/private/source.pdf'; },
    async verifySource(id) { assert.equal(id, documentId); events.push('verify'); return true; },
  };
  const adapter = { async execute(operation) { events.push(operation); return { stdout: outputs[operation], stderr: '', exitCode: 0 }; } };
  const service = new PdfService({ store, registry: {}, adapter });
  const result = await service.inspectStructure(documentId);
  assert.equal(result.pageCount, 1);
  assert.deepEqual(events, [
    'verify', 'inspect', 'verify', 'inspectPageBoxes', 'inspectMetadata', 'inspectCustomMetadata',
    'inspectDestinations', 'inspectUrls', 'inspectStructure', 'verify',
  ]);

  const swappedEvents = [];
  let sourceValid = true;
  const swappedStore = {
    ...store,
    async verifySource() {
      swappedEvents.push('verify');
      if (!sourceValid) throw new HostError('SOURCE_CHANGED', 'Source changed during inspection.', 409);
      return true;
    },
  };
  const swappedAdapter = {
    async execute(operation) {
      swappedEvents.push(operation);
      if (operation === 'inspect') sourceValid = false;
      return { stdout: outputs[operation], stderr: '', exitCode: 0 };
    },
  };
  await assert.rejects(new PdfService({ store: swappedStore, registry: {}, adapter: swappedAdapter }).inspectStructure(documentId), {
    code: 'SOURCE_CHANGED', status: 409,
  });
  assert.deepEqual(swappedEvents, ['verify', 'inspect', 'verify']);
});

test('signature parser separates offline integrity and coverage from unverified identity claims', () => {
  const valid = parseSignatures(makePdfsigOutput(), { expectedInputPath: '/private/source.pdf' });
  assert.equal(valid.status, 'valid');
  assert.equal(valid.integrityStatus, 'valid');
  assert.equal(valid.coverageStatus, 'full');
  assert.equal(valid.currentDocumentStatus, 'valid');
  assert.equal(valid.signatureCount, 1);
  assert.deepEqual(valid.signatures[0], {
    index: 1,
    claimedSigner: {
      commonName: 'Platen Test',
      distinguishedName: 'O=Local Fixture,CN=Platen Test',
    },
    claimedSigningTime: 'Jul 18 2026 23:40:55',
    hashAlgorithm: 'SHA-256',
    signatureType: 'adbe.pkcs7.detached',
    byteRange: [0, 1340, 4524, 315],
    documentCoverage: 'full',
    integrity: 'valid',
    certificate: 'not-checked',
    revocation: 'not-checked',
    timestamp: 'not-checked',
    identityVerified: false,
  });
  assert.equal(valid.limitations.length, 3);
  assert.equal('raw' in valid, false);
  assert.doesNotMatch(JSON.stringify(valid), /\/private\/source\.pdf|Signature1/);

  const invalid = parseSignatures(makePdfsigOutput({
    validation: 'Signature is Invalid.', hashAlgorithm: 'unknown',
  }));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.signatures[0].integrity, 'invalid');

  const priorRevision = parseSignatures(makePdfsigOutput({ coverage: 'Not total document signed' }));
  assert.equal(priorRevision.status, 'valid');
  assert.equal(priorRevision.coverageStatus, 'prior-revision');
  assert.equal(priorRevision.currentDocumentStatus, 'modified-after-signing');
  assert.equal(priorRevision.signatures[0].documentCoverage, 'prior-revision');

  for (const [validation, expected] of [
    ['Digest Mismatch.', 'invalid'],
    ["Document isn't signed or corrupted data.", 'invalid'],
    ['Signature not found.', 'indeterminate'],
    ['Signature has not yet been verified.', 'indeterminate'],
    ['Unknown Validation Failure.', 'indeterminate'],
  ]) {
    const parsed = parseSignatures(makePdfsigOutput({ validation }));
    assert.equal(parsed.integrityStatus, expected);
  }

  for (const output of [
    makePdfsigOutput().replace('  - Signed Ranges: [0 - 1340], [4524 - 4839]\n', ''),
    makePdfsigOutput().replace('  - Signature Type:', '  - Unknown Field:'),
    makePdfsigOutput().replace('  - Total document signed\n', '  - Total document signed\n  - Total document signed\n'),
    makePdfsigOutput().replace('[0 - 1340], [4524 - 4839]', '[10 - 1340], [4524 - 4839]'),
  ]) {
    assert.throws(() => parseSignatures(output), {
      code: 'SIGNATURE_OUTPUT_UNRECOGNIZED', status: 502,
    });
  }
  assert.throws(
    () => parseSignatures(makePdfsigOutput(), { expectedInputPath: '/private/other.pdf' }),
    { code: 'SIGNATURE_OUTPUT_UNRECOGNIZED', status: 502 },
  );
});

test('offline signature executor accepts only strict exit, stderr, and private NSS bindings', async () => {
  const input = '/private/source.pdf';
  const nssDirectory = '/private/signature-job';
  const calls = [];
  const unsigned = await executeOfflineSignatureInspection({
    async execute(operation, parameters, options) {
      calls.push({ operation, parameters, options });
      throw Object.assign(new Error('unsigned'), {
        exitCode: 2,
        stdout: `File '${input}' does not contain any signatures\n`,
        stderr: 'NSS_Init failed: security library: bad database.\n',
      });
    },
  }, { input, nssDirectory });
  assert.equal(unsigned.status, 'unsigned');
  assert.equal(unsigned.signatureCount, 0);
  assert.deepEqual(calls[0].parameters, { input, nssDirectory });
  assert.equal(calls[0].options.cwd, nssDirectory);

  await assert.rejects(executeOfflineSignatureInspection({
    async execute() {
      throw Object.assign(new Error('unexpected backend diagnostic'), {
        exitCode: 2,
        stdout: `File '${input}' does not contain any signatures\n`,
        stderr: 'ambient backend warning\n',
      });
    },
  }, { input, nssDirectory }), {
    code: 'SIGNATURE_INSPECTION_UNAVAILABLE', status: 503,
  });
  await assert.rejects(executeOfflineSignatureInspection({
    async execute() {
      return { stdout: makePdfsigOutput({ input, validation: 'Signature is Invalid.' }), stderr: '', exitCode: 0 };
    },
  }, { input, nssDirectory }), {
    code: 'SIGNATURE_OUTPUT_UNRECOGNIZED', status: 502,
  });
});
