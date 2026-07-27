import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseClassicPdfStructure, resolveClassicPdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { parsePdfStructure, resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { planClassicObjectTransaction, planPdfObjectTransaction } from '../scripts/host/pdf-classic-object-transaction.mjs';
import { buildClassicIncrementalRevision, buildPdfIncrementalRevision, verifyClassicIncrementalRevision, verifyPdfIncrementalRevision } from '../scripts/host/pdf-classic-incremental-revision.mjs';
import { verifyClosedClassicPdfOutput } from '../scripts/host/pdf-classic-closed-output.mjs';
import { buildPdfCompactRewrite } from '../scripts/host/pdf-compact-rewrite.mjs';
import { makeXrefStreamPdf } from './support/pdf-xref-stream-fixture.js';
import { makeWZeroXrefStreamSection } from './support/pdf-xref-stream-fixture.js';
import { makeObjectStreamPdf } from './support/pdf-xref-stream-fixture.js';
import { parseXrefStreamSection } from '../scripts/host/pdf-xref-stream.mjs';

const ref = (object, generation = 0) => Object.freeze({ type: 'ref', object, generation });
const name = (value) => Object.freeze({ type: 'name', value });
const text = (value) => Object.freeze({ type: 'string', bytes: Buffer.from(value, 'latin1') });
const dict = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });
const execFileAsync = promisify(execFile);

function changedCompressedPayload(source, byteDelta) {
  const streamMarker = Buffer.from('\nstream\n', 'latin1');
  const streamStart = source.lastIndexOf(streamMarker) + streamMarker.length;
  const streamEnd = source.indexOf(Buffer.from('\nendstream', 'latin1'), streamStart);
  const payload = source.subarray(streamStart, streamEnd);
  const replacement = byteDelta > 0
    ? Buffer.concat([payload, Buffer.alloc(byteDelta)])
    : payload.subarray(0, payload.length + byteDelta);
  const prefix = source.subarray(0, streamStart).toString('latin1')
    .replace(`/Length ${payload.length}`, `/Length ${replacement.length}`);
  return Buffer.concat([
    Buffer.from(prefix, 'latin1'), replacement, source.subarray(streamEnd),
  ]);
}

function xrefRow(type, field2, field3) {
  const bytes = Buffer.alloc(7); bytes[0] = type;
  bytes.writeUInt32BE(field2, 1); bytes.writeUInt16BE(field3, 5);
  return bytes;
}

function finalXrefOffset(source) {
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(source.toString('latin1'));
  assert.ok(match); return Number(match[1]);
}

function xrefIndex(objects) {
  const groups = []; let first = objects[0]; let count = 1;
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index] === objects[index - 1] + 1) count += 1;
    else { groups.push(first, count); first = objects[index]; count = 1; }
  }
  groups.push(first, count); return groups.join(' ');
}

function appendXrefStream(source, { bodies = [], rows = [], controlObject, size }) {
  const chunks = []; const offsets = new Map(); let length = source.length;
  for (const body of bodies) {
    offsets.set(body.object, length);
    const bytes = Buffer.from(`${body.object} ${body.generation ?? 0} obj\n${body.value}\nendobj\n`, 'latin1');
    chunks.push(bytes); length += bytes.length;
  }
  const controlOffset = length;
  const resolved = [...rows, { object: controlObject, type: 1, field2: controlOffset, field3: 0 }]
    .sort((left, right) => left.object - right.object)
    .map((entry) => ({ ...entry, field2: entry.field2 === 'offset' ? offsets.get(entry.object) : entry.field2 }));
  const payload = Buffer.concat(resolved.map((entry) => xrefRow(entry.type, entry.field2, entry.field3)));
  const index = xrefIndex(resolved.map((entry) => entry.object));
  const header = Buffer.from(`${controlObject} 0 obj\n<< /Type /XRef /W [1 4 2] /Index [${index}] /Size ${size} /Prev ${finalXrefOffset(source)} /Length ${payload.length} >>\nstream\n`, 'latin1');
  const tail = Buffer.from(`\nendstream\nendobj\nstartxref\n${controlOffset}\n%%EOF\n`, 'latin1');
  return Buffer.concat([source, ...chunks, header, payload, tail]);
}

function appendClassicContainerReplacement(source) {
  const body = Buffer.from('3 0 obj\n<< /Reused true >>\nendobj\n', 'latin1');
  const offset = source.length; const xrefOffset = offset + body.length;
  const tail = Buffer.from(`xref\n3 1\n${String(offset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 8 /Prev ${finalXrefOffset(source)} >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  return Buffer.concat([source, body, tail]);
}

test('generic xref-stream transaction appends a verified classic replacement and addition', () => {
  const source = makeXrefStreamPdf();
  assert.throws(() => parseClassicPdfStructure(source), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  const structure = parsePdfStructure(source);
  assert.equal(structure.xrefFlavor, 'stream');
  assert.deepEqual([...structure.controlObjectNumbers], [7]);
  assert.throws(() => resolveClassicPdfObject(structure, ref(1)), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  assert.equal(resolvePdfObject(structure, ref(1)).value.entries.get('Type').value, 'Catalog');
  const plan = planPdfObjectTransaction({
    sourceBytes: source,
    sourceStructure: structure,
    updates: [{ reference: ref(2), value: dict([['Title', text('New')]]) }],
    additions: [{ id: 'added', value: dict([['Kind', name('Added')]]) }],
    info: { kind: 'preserve' },
    changingId: null,
  });
  assert.match(plan.revision.bytes.toString('latin1'), /xref\n2 1\n[\s\S]*8 1\n/u);
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  assert.equal(outputBytes.subarray(0, source.length).equals(source), true);
  const proof = verifyPdfIncrementalRevision({
    sourceBytes: source, outputBytes, sourceStructure: structure, expectedRevision: plan.revision,
  });
  assert.equal(resolvePdfObject(proof.outputStructure, ref(2)).value.entries.get('Title').bytes.toString('latin1'), 'New');
  assert.equal(resolvePdfObject(proof.outputStructure, plan.referencesById.added).value.entries.get('Kind').value, 'Added');
  assert.equal(proof.outputStructure.revisions[0].xrefKind, 'classic');
  assert.equal(proof.outputStructure.revisions[1].xrefKind, 'stream');
  assert.equal(proof.outputStructure.revisions[0].trailer.get('Prev').value, structure.revisions[0].offset);
  assert.equal(proof.outputStructure.controlObjectNumbers.has(7), true);
  assert.throws(() => parseClassicPdfStructure(outputBytes), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
});

test('generic parser rejects orphan type-2 rows and unsupported stream filters', () => {
  assert.throws(() => parsePdfStructure(makeXrefStreamPdf({ objectTwoType: 2 })), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
  assert.throws(() => parsePdfStructure(makeXrefStreamPdf({ objectTwoType: 3 })), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
  const unsupported = Buffer.from(makeXrefStreamPdf().toString('latin1').replace('/FlateDecode', '/LZWDecode'), 'latin1');
  assert.throws(() => parsePdfStructure(unsupported), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
});

test('generic parser admits every bounded filter pipeline for xref and object streams', () => {
  const pipelines = [
    ['ASCIIHexDecode'], ['ASCII85Decode'], ['FlateDecode'], ['RunLengthDecode'],
    ['ASCIIHexDecode', 'FlateDecode'], ['ASCII85Decode', 'FlateDecode'],
    ['ASCIIHexDecode', 'RunLengthDecode'], ['ASCII85Decode', 'RunLengthDecode'],
  ];
  for (const filters of pipelines) {
    assert.equal(parsePdfStructure(makeXrefStreamPdf({ xrefFilters: filters })).xrefFlavor, 'stream');
    const source = makeObjectStreamPdf({ filtered: false, compressedCatalog: true, objectFilters: filters, xrefFilters: filters });
    const structure = parsePdfStructure(source); const catalog = resolvePdfObject(structure, structure.root);
    assert.equal(catalog.value.entries.get('Type').value, 'Catalog');
    assert.equal(catalog.storage.filter, filters.join('+'));
    assert.equal(verifyClosedClassicPdfOutput(buildPdfCompactRewrite(source).bytes).closed, true);
  }
  for (const filters of [['ASCIIHexDecode', 'FlateDecode'], ['ASCII85Decode', 'FlateDecode']]) {
    assert.equal(parseXrefStreamSection(makeWZeroXrefStreamSection({ xrefFilters: filters }), 9).entries.length, 1);
  }
  const predictor = { declared: 15, columns: 7 };
  const predictedXref = makeXrefStreamPdf({ xrefFilters: ['FlateDecode'], xrefPredictor: predictor });
  assert.equal(parsePdfStructure(predictedXref).xrefFlavor, 'stream');
  const wrongColumns = Buffer.from(predictedXref.toString('latin1').replace('/Columns 7', '/Columns 6'), 'latin1');
  assert.throws(() => parsePdfStructure(wrongColumns), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  const predicted = makeObjectStreamPdf({ filtered: false, compressedCatalog: true, objectFilters: ['FlateDecode'], xrefFilters: ['FlateDecode'], objectPredictor: { declared: 15 }, xrefPredictor: predictor });
  const predictedStructure = parsePdfStructure(predicted);
  const predictorProof = resolvePdfObject(predictedStructure, predictedStructure.root).storage.predictor;
  assert.equal(predictorProof.kind, 'png'); assert.equal(predictorProof.declared, 15); assert.ok(predictorProof.columns > 0);
  assert.equal(verifyClosedClassicPdfOutput(buildPdfCompactRewrite(predicted).bytes).closed, true);
  const corruptPredictor = Buffer.from(predicted); const payloadStart = corruptPredictor.lastIndexOf(Buffer.from('\nstream\n', 'latin1')) + 8; corruptPredictor[payloadStart] ^= 0xff;
  assert.throws(() => parsePdfStructure(corruptPredictor), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
});

test('generic APIs resolve bounded identity and Flate object-stream members then shadow them classically', () => {
  for (const filtered of [false, true]) {
    const source = makeObjectStreamPdf({ filtered }); const structure = parsePdfStructure(source);
    assert.deepEqual(structure.effective.get(2), {
      xrefType: 2, object: 2, status: 'c', objectStream: 3, index: 0, generation: 0,
    });
    assert.equal(resolvePdfObject(structure, ref(2)).value.entries.get('Title').bytes.toString('latin1'), 'Old');
    assert.throws(() => resolveClassicPdfObject(structure, ref(2)), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
    const plan = planPdfObjectTransaction({
      sourceBytes: source, sourceStructure: structure,
      updates: [{ reference: ref(2), value: dict([['Title', text('New')]]) }],
      additions: [], info: { kind: 'preserve' }, changingId: null,
    });
    const output = Buffer.concat([source, plan.revision.bytes]);
    assert.equal(output.subarray(0, source.length).equals(source), true);
    const proof = verifyPdfIncrementalRevision({
      sourceBytes: source, sourceStructure: structure,
      outputBytes: output, expectedRevision: plan.revision,
    });
    assert.equal(resolvePdfObject(proof.outputStructure, ref(2)).value.entries.get('Title').bytes.toString('latin1'), 'New');
    assert.equal(proof.sourceXrefFlavor, 'stream');
    assert.equal(proof.appendedXrefFlavor, 'classic');
    assert.equal(proof.compressedObjectsRead, 1);
    assert.equal(proof.compressedObjectsRewrittenUncompressed, 1);
  }
});

test('compressed Catalog and Info resolve with explicit storage provenance', () => {
  for (const filtered of [false, true]) {
    const source = makeObjectStreamPdf({ filtered, compressedCatalog: true });
    const structure = parsePdfStructure(source);
    const catalog = resolvePdfObject(structure, structure.root);
    const info = resolvePdfObject(structure, structure.info);
    assert.equal(structure.effective.get(1).status, 'c');
    assert.equal(structure.effective.get(2).status, 'c');
    assert.equal(catalog.value.entries.get('Type').value, 'Catalog');
    assert.equal(info.value.entries.get('Title').bytes.toString('latin1'), 'Old');
    assert.deepEqual(catalog.storage, {
      kind: 'compressed', revisionOffset: structure.revisions[0].offset,
      objectStream: { object: 3, generation: 0 },
      objectStreamOffset: structure.effective.get(3).offset, index: 0,
      decodedStart: catalog.storage.decodedStart, decodedEnd: catalog.storage.decodedEnd,
      filter: filtered ? 'FlateDecode' : 'identity',
    });
    assert.equal(Object.hasOwn(catalog, 'start'), false);
    assert.equal(Object.hasOwn(catalog, 'end'), false);
    assert.equal(Object.hasOwn(catalog, 'buffer'), false);
    assert.equal(Object.hasOwn(resolvePdfObject(structure, ref(4)), 'buffer'), false);
  }
});

test('generic resolver authority ignores exposed-map and returned-value mutation', () => {
  const structure = parsePdfStructure(makeObjectStreamPdf({ filtered: false }));
  const first = resolvePdfObject(structure, structure.info);
  first.value.entries.get('Title').bytes[0] = 0x58;
  first.value.entries.clear();
  structure.effective.clear(); structure.objects.clear(); structure.compressedObjects.clear();
  const second = resolvePdfObject(structure, structure.info);
  assert.equal(second.value.entries.get('Title').bytes.toString('latin1'), 'Old');
  const forged = Object.freeze({ ...structure, effective: new Map(), objects: new Map() });
  assert.throws(() => resolvePdfObject(forged, structure.info), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
});

test('installed Poppler accepts compressed Catalog and Info before and after uncompressed shadowing', async (context) => {
  const tools = ['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'];
  try { await Promise.all(tools.map((path) => access(path))); } catch { context.skip('The fixed Poppler toolchain is unavailable.'); return; }
  const source = makeObjectStreamPdf({ compressedCatalog: true });
  const structure = parsePdfStructure(source);
  const plan = planPdfObjectTransaction({
    sourceBytes: source, sourceStructure: structure,
    updates: [{ reference: ref(2), value: dict([['Title', text('Shadowed')]]) }],
    additions: [], info: { kind: 'preserve' }, changingId: null,
  });
  const directory = await mkdtemp(join(tmpdir(), 'pdf-object-stream-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [join(directory, 'source.pdf'), join(directory, 'output.pdf')];
  await writeFile(paths[0], source); await writeFile(paths[1], Buffer.concat([source, plan.revision.bytes]));
  for (const [index, path] of paths.entries()) {
    const info = await execFileAsync('/opt/homebrew/bin/pdfinfo', [path]);
    assert.match(info.stdout, new RegExp(`^Title:\\s+${index === 0 ? 'Old' : 'Shadowed'}$`, 'mu'));
    await execFileAsync('/opt/homebrew/bin/pdftotext', [path, '-']);
    const renderRoot = join(directory, `render-${index}`);
    await execFileAsync('/opt/homebrew/bin/pdftocairo', ['-png', '-singlefile', '-f', '1', '-l', '1', path, renderRoot]);
    await access(`${renderRoot}.png`);
  }
});

test('object-stream authority permits exact repeats but rejects recompression and container reuse', () => {
  const source = makeObjectStreamPdf({ filtered: false });
  const repeated = appendXrefStream(source, {
    controlObject: 8, size: 9,
    rows: [{ object: 2, type: 2, field2: 3, field3: 0 }],
  });
  const repeatedStructure = parsePdfStructure(repeated);
  assert.equal(resolvePdfObject(repeatedStructure, ref(2)).value.entries.get('Title').bytes.toString('latin1'), 'Old');

  const member = '2 0 << /Title (Recompressed) >>';
  const recompressed = appendXrefStream(source, {
    bodies: [{ object: 8, value: `<< /Type /ObjStm /N 1 /First 4 /Length ${Buffer.byteLength(member, 'latin1')} >>\nstream\n${member}\nendstream` }],
    rows: [
      { object: 2, type: 2, field2: 8, field3: 0 },
      { object: 8, type: 1, field2: 'offset', field3: 0 },
    ],
    controlObject: 9, size: 10,
  });
  assert.throws(() => parsePdfStructure(recompressed), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  assert.throws(() => parsePdfStructure(appendClassicContainerReplacement(source)), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
});

test('a new unreferenced object stream cannot hide behind an exact repeated compressed row', () => {
  const source = makeObjectStreamPdf({ filtered: false });
  const member = '10 0 << /Unused true >>';
  const candidate = appendXrefStream(source, {
    bodies: [{ object: 8, value: `<< /Type /ObjStm /N 1 /First 5 /Length ${Buffer.byteLength(member, 'latin1')} >>\nstream\n${member}\nendstream` }],
    rows: [
      { object: 2, type: 2, field2: 3, field3: 0 },
      { object: 8, type: 1, field2: 'offset', field3: 0 },
    ],
    controlObject: 9, size: 11,
  });
  assert.throws(() => parsePdfStructure(candidate), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
});

test('every strict classic API rejects the accepted object-stream source', () => {
  const source = makeObjectStreamPdf(); const structure = parsePdfStructure(source);
  const request = {
    sourceBytes: source, sourceStructure: structure,
    updates: [{ reference: ref(2), value: dict([['Title', text('No')]]) }],
    additions: [], info: { kind: 'preserve' }, changingId: null,
  };
  assert.throws(() => parseClassicPdfStructure(source), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  assert.throws(() => resolveClassicPdfObject(structure, ref(2)), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  assert.throws(() => planClassicObjectTransaction(request), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
  assert.throws(() => buildClassicIncrementalRevision({ ...request, records: [], effectiveSize: 8, infoReference: structure.info }), {
    code: 'INVALID_CLASSIC_INCREMENTAL_REVISION',
  });
  assert.throws(() => verifyClassicIncrementalRevision({
    sourceBytes: source, sourceStructure: structure, outputBytes: source, expectedRevision: {},
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
  for (const records of [
    [{ reference: ref(3), value: dict([]) }],
    [{ reference: ref(8), value: dict([['Type', name('ObjStm')]]) }],
    [{ reference: ref(8), value: dict([['Type', name('XRef')]]) }],
  ]) assert.throws(() => buildPdfIncrementalRevision({
    sourceBytes: source, sourceStructure: structure, records,
    effectiveSize: records[0].reference.object < 8 ? 8 : 9,
    infoReference: structure.info, changingId: null,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
});

test('generic parser accepts unfiltered and omitted Index controls, and rejects malformed control fields', () => {
  assert.equal(parsePdfStructure(makeXrefStreamPdf({ filtered: false, explicitIndex: false })).xrefFlavor, 'stream');
  assert.equal(parseXrefStreamSection(makeWZeroXrefStreamSection(), 9).entries[0].status, 'n');
  assert.throws(() => parsePdfStructure(makeXrefStreamPdf({ badSelf: true })), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  for (const replace of [
    ['/W [1 4 2]', '/W [1 9 2]'],
    ['/Index [0 8]', '/Index [0 9]'],
    ['/Index [0 8]', '/Index [0 4 3 5]'],
    ['/Type /XRef', '/Type /XRef /Encrypt 1 0 R'],
    ['/Type /XRef', '/Type /XRef /XRefStm 1'],
    ['/W [1 4 2]', '/W 1 0 R'],
    ['/Size 8', '/Size 1 0 R'],
    [/\/Length \d+/, '/Length 2 0 R'],
  ]) {
    const candidate = Buffer.from(makeXrefStreamPdf().toString('latin1').replace(...replace), 'latin1');
    assert.throws(() => parsePdfStructure(candidate), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  }
});

test('generic parser rejects corrupt compressed controls and transactions cannot update controls', () => {
  const source = makeXrefStreamPdf();
  const corrupt = Buffer.from(source);
  const streamMarker = Buffer.from('\nstream\n', 'latin1');
  const marker = corrupt.lastIndexOf(streamMarker) + streamMarker.length;
  corrupt[marker] ^= 0xff;
  assert.throws(() => parsePdfStructure(corrupt), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  for (const candidate of [
    changedCompressedPayload(source, -1),
    changedCompressedPayload(source, 1),
    makeXrefStreamPdf({ catalogOffsetDelta: 1 }),
    Buffer.from(source.toString('latin1').replace('\nstartxref\n', ' startxref\n'), 'latin1'),
  ]) assert.throws(() => parsePdfStructure(candidate), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  const structure = parsePdfStructure(source);
  assert.throws(() => planPdfObjectTransaction({
    sourceBytes: source, sourceStructure: structure,
    updates: [{ reference: ref(7), value: dict([]) }], additions: [], info: { kind: 'preserve' }, changingId: null,
  }), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
});

test('strict closed-output verification rejects an otherwise valid xref-stream source', () => {
  const source = makeXrefStreamPdf();
  assert.equal(parsePdfStructure(source).xrefFlavor, 'stream');
  assert.throws(() => verifyClosedClassicPdfOutput(source), {
    code: 'INVALID_CLOSED_CLASSIC_PDF_OUTPUT',
  });
});

test('installed Poppler inspects, extracts, and renders chained xref source, classic append, and compact closure', async (context) => {
  const tools = ['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'];
  try { await Promise.all(tools.map((path) => access(path))); } catch { context.skip('The fixed Poppler toolchain is unavailable.'); return; }
  const filters = ['ASCII85Decode', 'FlateDecode'];
  const source = makeObjectStreamPdf({ filtered: false, compressedCatalog: true, objectFilters: filters, xrefFilters: filters, objectPredictor: { declared: 15, columns: 1, methods: [0, 1, 2, 3, 4] }, xrefPredictor: { declared: 15, columns: 7, methods: [0, 1, 2, 3, 4, 0, 1, 2] } });
  const structure = parsePdfStructure(source);
  const plan = planPdfObjectTransaction({
    sourceBytes: source, sourceStructure: structure,
    updates: [{ reference: ref(2), value: dict([['Title', text('Poppler')]]) }],
    additions: [], info: { kind: 'preserve' }, changingId: null,
  });
  const directory = await mkdtemp(join(tmpdir(), 'pdf-xref-stream-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.pdf');
  const outputPath = join(directory, 'output.pdf');
  const compactPath = join(directory, 'compact.pdf');
  await writeFile(sourcePath, source);
  await writeFile(outputPath, Buffer.concat([source, plan.revision.bytes]));
  await writeFile(compactPath, buildPdfCompactRewrite(source).bytes);
  const sourceInfo = await execFileAsync('/opt/homebrew/bin/pdfinfo', [sourcePath]);
  const outputInfo = await execFileAsync('/opt/homebrew/bin/pdfinfo', [outputPath]);
  assert.match(sourceInfo.stdout, /^Title:\s+Old$/mu);
  assert.match(outputInfo.stdout, /^Title:\s+Poppler$/mu);
  for (const [index, path] of [sourcePath, outputPath, compactPath].entries()) {
    await execFileAsync('/opt/homebrew/bin/pdftotext', [path, '-']);
    const renderRoot = join(directory, `render-${index}`);
    await execFileAsync('/opt/homebrew/bin/pdftocairo', [
      '-png', '-singlefile', '-f', '1', '-l', '1', path, renderRoot,
    ]);
    await access(`${renderRoot}.png`);
  }
});
