import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findFinalStartXref,
  parseClassicXrefSection,
} from '../scripts/host/pdf-classic-syntax.mjs';
import {
  inspectIncrementalPdfMetadata,
  writeIncrementalPdfMetadata,
} from '../scripts/host/pdf-incremental-metadata-writer.mjs';

const metadata = Object.freeze({
  title: 'Résumé 😀', author: 'Ada', subject: null, keywords: 'alpha, beta',
});

function fixture({
  bodies = new Map([[1, '<< /Type /Catalog >>']]), size,
  info = null, id = null, trailerExtra = '', prefix = '', entries = null,
} = {}) {
  const chunks = [`%PDF-1.7\n${prefix}`];
  const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  const rows = entries ?? [
    { object: 0, generation: 65_535, offset: 0, status: 'f' },
    ...[...offsets].map(([object, offset]) => ({ object, generation: 0, offset, status: 'n' })),
  ];
  chunks.push('xref\n');
  for (const row of rows) {
    chunks.push(`${row.object} 1\n${String(row.offset).padStart(10, '0')} ${String(row.generation).padStart(5, '0')} ${row.status} \n`);
  }
  const effectiveSize = size ?? Math.max(...[...offsets.keys()]) + 1;
  const infoEntry = info === null ? '' : ` /Info ${info} 0 R`;
  const idEntry = id === null ? '' : ` /ID [<${id[0]}> <${id[1]}>]`;
  chunks.push(`trailer\n<< /Size ${effectiveSize} /Root 1 0 R${infoEntry}${idEntry}${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Object.freeze({ bytes: Buffer.from(chunks.join(''), 'latin1'), offsets, xrefOffset });
}

function appendRepeatRevision(source, { previous = findFinalStartXref(source), trailerExtra = '' } = {}) {
  const xrefOffset = source.length + 1;
  const append = `\nxref\n1 1\n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R${trailerExtra} /Prev ${previous} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([source, Buffer.from(append, 'latin1')]);
}

function appendRevision(source, { entries, size, root = '1 0 R' }) {
  const previous = findFinalStartXref(source);
  const xrefOffset = source.length + 1;
  const rows = entries.map((entry) => `${entry.object} 1\n${String(entry.offset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} ${entry.status} \n`).join('');
  const tail = `\nxref\n${rows}trailer\n<< /Size ${size} /Root ${root} /Prev ${previous} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([source, Buffer.from(tail, 'latin1')]);
}

function sourceWithInfo({ id = null, size = 5 } = {}) {
  return fixture({
    bodies: new Map([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Count 0 /Kids [] >>'],
      [4, '<< /Title (Old) /Author (Old author) /Producer (Fixture) /Custom << /Flag true /Ratio 1.0 /Label /A#20B /Bytes <0A0B> /Ref 1 0 R >> >>'],
    ]),
    size, info: 4, id,
  }).bytes;
}

test('writer is deterministic, preserves the exact source prefix, and proves canonical metadata', () => {
  const source = sourceWithInfo();
  const first = writeIncrementalPdfMetadata(source, metadata);
  const second = writeIncrementalPdfMetadata(source, metadata);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.subarray(0, source.length).equals(source), true);
  assert.deepEqual(first.proof, {
    profile: 'local-classic-incremental-metadata-v1',
    sourceBytes: source.length, outputBytes: first.bytes.length,
    appendedBytes: first.bytes.length - source.length,
    sourcePrefixPreserved: true, priorObjectOffsetsPreserved: true, revisionCount: 2,
    previousXrefOffset: findFinalStartXref(source), appendedXrefOffset: findFinalStartXref(first.bytes),
    infoObjectNumber: 5, infoGeneration: 0, effectiveSize: 6, rootPreserved: true,
    idPolicy: 'absent', metadataFieldCount: 4,
  });
  const tail = first.bytes.subarray(source.length).toString('latin1');
  assert.match(tail, /5 0 obj\n/);
  assert.match(tail, /\/Producer <46697874757265>/);
  assert.match(tail, /\/Ratio 1[.]0/);
  assert.match(tail, /\/Title <FEFF/);
  assert.doesNotMatch(tail, /Old author|\/Subject/);
  assert.deepEqual(inspectIncrementalPdfMetadata(source, first.bytes, metadata), first.proof);
});

test('writer uses effective Size as a fresh object and updates only the changing ID', () => {
  const source = sourceWithInfo({ id: ['11'.repeat(16), '22'.repeat(16)], size: 20 });
  const first = writeIncrementalPdfMetadata(source, metadata);
  const second = writeIncrementalPdfMetadata(source, { ...metadata, title: 'Different' });
  assert.equal(first.proof.infoObjectNumber, 20);
  assert.equal(first.proof.effectiveSize, 21);
  assert.equal(first.proof.idPolicy, 'permanent-preserved-changing-updated');
  const firstId = /\/ID \[<([0-9A-F]+)> <([0-9A-F]+)>\]/.exec(first.bytes.subarray(source.length).toString('latin1'));
  const secondId = /\/ID \[<([0-9A-F]+)> <([0-9A-F]+)>\]/.exec(second.bytes.subarray(source.length).toString('latin1'));
  assert.equal(firstId[1], '11'.repeat(16).toUpperCase());
  assert.equal(secondId[1], firstId[1]);
  assert.notEqual(secondId[2], firstId[2]);
  assert.equal(firstId[2].length, 32);
});

test('writer follows bounded Prev chains and rejects cycles or excessive depth', () => {
  const base = fixture().bytes;
  const two = appendRepeatRevision(base);
  assert.equal(writeIncrementalPdfMetadata(two, metadata).proof.revisionCount, 3);
  let maximum = base;
  for (let index = 1; index < 31; index += 1) maximum = appendRepeatRevision(maximum);
  assert.equal(writeIncrementalPdfMetadata(maximum, metadata).proof.revisionCount, 32);
  const tooDeep = appendRepeatRevision(maximum);
  assert.throws(() => writeIncrementalPdfMetadata(tooDeep, metadata), {
    code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF',
  });
  const selfOffset = base.length + 1;
  const selfCycle = appendRepeatRevision(base, { previous: selfOffset });
  assert.throws(() => writeIncrementalPdfMetadata(selfCycle, metadata), {
    code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF',
  });
});

test('writer rejects xref streams, hybrid/encrypted/unknown trailers, duplicates, and wrong offsets', () => {
  const xrefStream = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /XRef /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n');
  const base = fixture();
  const duplicateRows = [
    { object: 0, generation: 65_535, offset: 0, status: 'f' },
    { object: 1, generation: 0, offset: base.offsets.get(1), status: 'n' },
    { object: 1, generation: 0, offset: base.offsets.get(1), status: 'n' },
  ];
  const hostile = [
    xrefStream,
    fixture({ trailerExtra: ' /XRefStm 9' }).bytes,
    fixture({ trailerExtra: ' /Encrypt 1 0 R' }).bytes,
    fixture({ trailerExtra: ' /Unsafe true' }).bytes,
    fixture({ entries: duplicateRows }).bytes,
    fixture({ entries: [{ object: 1, generation: 0, offset: 10, status: 'n' }] }).bytes,
  ];
  for (const source of hostile) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer rejects invalid headers, non-Catalog roots, permissions, and encoded object streams', () => {
  const directStream = (type) => `<< /Type /${type} /Length 0 >>\nstream\nendstream`;
  const hostile = [
    Buffer.from(fixture().bytes.subarray(1)),
    Buffer.concat([Buffer.from('%PDF-9.9\n'), fixture().bytes.subarray('%PDF-1.7\n'.length)]),
    fixture({ bodies: new Map([[1, '<< /Type /Pages >>']]) }).bytes,
    fixture({ bodies: new Map([[1, '<< /Type /Catalog /Perms <<>> >>']]) }).bytes,
    fixture({ bodies: new Map([[1, '<< /Type /Catalog >>'], [2, directStream('ObjStm')]]) }).bytes,
    fixture({ bodies: new Map([[1, '<< /Type /Catalog >>'], [2, directStream('XRef')]]) }).bytes,
    fixture({ entries: [{ object: 1, generation: 0, offset: 9, status: 'n' }] }).bytes,
  ];
  for (const source of hostile) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer rejects decreasing Size and xref entries targeting object decoys inside prior trailers', () => {
  const decreasing = appendRepeatRevision(fixture({ size: 3 }).bytes);
  assert.throws(() => writeIncrementalPdfMetadata(decreasing, metadata), {
    code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF',
  });

  const chunks = ['%PDF-1.7\n', '1 0 obj\n<< /Type /Catalog >>\nendobj\n'];
  const rootOffset = Buffer.byteLength(chunks.join(''), 'latin1') - Buffer.byteLength(chunks[1], 'latin1');
  const firstXref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 2\n0000000000 65535 f \n${String(rootOffset).padStart(10, '0')} 00000 n \n`);
  const decoyOffset = Buffer.byteLength(chunks.join(''), 'latin1') + 2;
  chunks.push('% 2 0 obj << /Decoy true >> endobj\n');
  chunks.push(`trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${firstXref}\n%%EOF\n`);
  const first = Buffer.from(chunks.join(''), 'latin1');
  const secondXref = first.length + 1;
  const tail = `\nxref\n2 1\n${String(decoyOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R /Prev ${firstXref} >>\nstartxref\n${secondXref}\n%%EOF\n`;
  const targetedDecoy = Buffer.concat([first, Buffer.from(tail, 'latin1')]);
  assert.throws(() => writeIncrementalPdfMetadata(targetedDecoy, metadata), {
    code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF',
  });
});

test('writer anchors final markers and xref targets outside same-line comments', () => {
  const base = fixture().bytes;
  const oldXref = findFinalStartXref(base);
  const commentMarker = Buffer.concat([
    base,
    Buffer.from(`% startxref\n${oldXref}\n%%EOF\n`, 'latin1'),
  ]);
  const header = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ';
  const xrefOffset = Buffer.byteLength(header, 'latin1');
  const commentedXref = Buffer.from(`${header}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  for (const source of [commentMarker, commentedXref]) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer rejects backward decoy promotion and resurrection after a free entry', () => {
  const decoy = '2 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const padded = fixture({ prefix: decoy, size: 3 });
  const promoted = appendRevision(padded.bytes, {
    entries: [{ object: 2, generation: 0, offset: 9, status: 'n' }],
    size: 3, root: '2 0 R',
  });

  const base = fixture({ bodies: new Map([
    [1, '<< /Type /Catalog >>'], [2, '<< /Type /Catalog >>'],
  ]) });
  const freed = appendRevision(base.bytes, {
    entries: [{ object: 2, generation: 1, offset: 0, status: 'f' }], size: 3,
  });
  const resurrected = appendRevision(freed, {
    entries: [{ object: 2, generation: 0, offset: base.offsets.get(2), status: 'n' }],
    size: 3, root: '2 0 R',
  });
  const nestedCatalog = '3 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const streamBody = `<< /Length ${Buffer.byteLength(nestedCatalog)} >>\nstream\n${nestedCatalog}endstream`;
  const streamed = fixture({
    bodies: new Map([[1, '<< /Type /Catalog >>'], [2, streamBody]]), size: 4,
  });
  const nestedOffset = streamed.offsets.get(2) + Buffer.byteLength('2 0 obj\n', 'latin1')
    + streamBody.indexOf(nestedCatalog);
  const promotedFromPriorStream = appendRevision(streamed.bytes, {
    entries: [{ object: 3, generation: 0, offset: nestedOffset, status: 'n' }],
    size: 4, root: '3 0 R',
  });
  for (const source of [promoted, resurrected, promotedFromPriorStream]) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer rejects stale Size, an occupied fresh number, XMP, and malformed Info AST', () => {
  const malformedBodies = [
    '<< /Custom (unterminated >>',
    '<< /Custom /Bad#GG >>',
    '<< /Custom 1e3 >>',
    '<< /Custom 1 /Custom 2 >>',
  ];
  const hostile = [
    fixture({ bodies: new Map([[1, '<< /Type /Catalog >>'], [3, '<<>>']]), size: 3 }).bytes,
    fixture({ size: 2, entries: [
      { object: 0, generation: 65_535, offset: 0, status: 'f' },
      { object: 1, generation: 0, offset: 9, status: 'n' },
      { object: 2, generation: 0, offset: 0, status: 'f' },
    ] }).bytes,
    fixture({ bodies: new Map([[1, '<< /Type /Catalog /Metadata 2 0 R >>'], [2, '<<>>']]) }).bytes,
    ...malformedBodies.map((body) => fixture({
      bodies: new Map([[1, '<< /Type /Catalog >>'], [2, body]]), info: 2,
    }).bytes),
  ];
  for (const source of hostile) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer validates direct stream spans and rejects indirect lengths or embedded object targets', () => {
  const data = '3 0 obj\n<< /Injected true >>\nendobj\n';
  const streamBody = `<< /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}endstream`;
  const safe = fixture({ bodies: new Map([[1, '<< /Type /Catalog >>'], [2, streamBody]]) });
  assert.equal(writeIncrementalPdfMetadata(safe.bytes, metadata).proof.sourcePrefixPreserved, true);
  const embeddedOffset = safe.offsets.get(2) + Buffer.byteLength('2 0 obj\n', 'latin1')
    + streamBody.indexOf(data);
  const overlap = fixture({
    bodies: new Map([[1, '<< /Type /Catalog >>'], [2, streamBody]]), size: 4,
    entries: [
      { object: 0, generation: 65_535, offset: 0, status: 'f' },
      { object: 1, generation: 0, offset: safe.offsets.get(1), status: 'n' },
      { object: 2, generation: 0, offset: safe.offsets.get(2), status: 'n' },
      { object: 3, generation: 0, offset: embeddedOffset, status: 'n' },
    ],
  }).bytes;
  const indirect = fixture({ bodies: new Map([
    [1, '<< /Type /Catalog >>'],
    [2, '<< /Length 3 0 R >>\nstream\nabc\nendstream'],
    [3, '3'],
  ]) }).bytes;
  const decimalLength = fixture({ bodies: new Map([
    [1, '<< /Type /Catalog >>'], [2, '<< /Length 3.0 >>\nstream\nabc\nendstream'],
  ]) }).bytes;
  for (const source of [overlap, indirect, decimalLength]) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer rejects reachable page-level XMP and metadata/XML streams across the xref graph', () => {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/">private</x:xmpmeta>';
  const source = fixture({ bodies: new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Metadata 4 0 R >>'],
    [4, `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`],
  ]) }).bytes;
  assert.throws(() => writeIncrementalPdfMetadata(source, metadata), {
    code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF',
  });
});

test('writer bounds aggregate xref rows and the canonical append before output allocation', () => {
  const root = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const baseParts = ['%PDF-1.7\n', root, 'xref\n0 25001\n', '0000000000 65535 f \n', '0000000009 00000 n \n'];
  for (let object = 2; object <= 25_000; object += 1) baseParts.push('0000000000 00000 f \n');
  const baseXref = Buffer.byteLength('%PDF-1.7\n', 'latin1') + Buffer.byteLength(root, 'latin1');
  baseParts.push(`trailer\n<< /Size 50001 /Root 1 0 R >>\nstartxref\n${baseXref}\n%%EOF\n`);
  const base = Buffer.from(baseParts.join(''), 'latin1');
  const newerParts = [`\nxref\n25001 25000\n`];
  for (let object = 25_001; object <= 50_000; object += 1) newerParts.push('0000000000 00000 f \n');
  const newerXref = base.length + 1;
  newerParts.push(`trailer\n<< /Size 50001 /Root 1 0 R /Prev ${baseXref} >>\nstartxref\n${newerXref}\n%%EOF\n`);
  const tooManyRows = Buffer.concat([base, Buffer.from(newerParts.join(''), 'latin1')]);

  const largeEntries = [];
  for (let index = 0; index < 20; index += 1) largeEntries.push(`/Custom${index} (${'x'.repeat(30_000)})`);
  const largeInfo = fixture({ bodies: new Map([
    [1, '<< /Type /Catalog >>'], [2, `<< ${largeEntries.join(' ')} >>`],
  ]), info: 2 }).bytes;
  for (const source of [tooManyRows, largeInfo]) assert.throws(
    () => writeIncrementalPdfMetadata(source, metadata),
    { code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF' },
  );
});

test('writer shares one aggregate AST budget across every xref-selected object', () => {
  const nearPerObjectLimit = `[${'0 '.repeat(19_990)}]`;
  const bodies = new Map([[1, '<< /Type /Catalog >>']]);
  for (let object = 2; object <= 21; object += 1) bodies.set(object, nearPerObjectLimit);
  const source = fixture({ bodies }).bytes;
  assert.ok(source.length < 1024 * 1024);
  assert.throws(() => writeIncrementalPdfMetadata(source, metadata), {
    code: 'UNSUPPORTED_INCREMENTAL_METADATA_PDF',
  });
});

test('classic syntax shares the aggregate AST budget across revision trailers', () => {
  const parts = [];
  const offsets = [];
  const nearPerTrailerLimit = '0 '.repeat(19_990);
  for (let revision = 0; revision < 6; revision += 1) {
    const offset = Buffer.byteLength(parts.join(''), 'latin1');
    offsets.push(offset);
    parts.push(`xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Huge [${nearPerTrailerLimit}] >>\nstartxref\n${offset}\n%%EOF\n`);
  }
  const source = Buffer.from(parts.join(''), 'latin1');
  const budget = { items: 0, decodedBytes: 0 };
  for (const offset of offsets.slice(0, 5)) parseClassicXrefSection(source, offset, budget);
  assert.throws(() => parseClassicXrefSection(source, offsets[5], budget), {
    code: 'INVALID_CLASSIC_PDF_SYNTAX',
  });
});

test('independent inspection rejects any prefix, metadata, or canonical-tail tampering', () => {
  const source = sourceWithInfo();
  const output = writeIncrementalPdfMetadata(source, metadata).bytes;
  const prefixTampered = Buffer.from(output); prefixTampered[20] ^= 1;
  const tailTampered = Buffer.concat([output, Buffer.from(' ')]);
  for (const [candidate, expected] of [
    [prefixTampered, metadata], [tailTampered, metadata],
    [output, { ...metadata, title: 'Wrong' }],
  ]) assert.throws(
    () => inspectIncrementalPdfMetadata(source, candidate, expected),
    { code: 'INVALID_INCREMENTAL_METADATA_OUTPUT' },
  );
});

test('writer rejects a canonical no-op and public proof contains no metadata values', () => {
  const source = fixture().bytes;
  const first = writeIncrementalPdfMetadata(source, metadata);
  assert.throws(() => writeIncrementalPdfMetadata(first.bytes, metadata), {
    code: 'INVALID_INCREMENTAL_METADATA',
  });
  const serialized = JSON.stringify(first.proof);
  for (const value of Object.values(metadata).filter(Boolean)) assert.equal(serialized.includes(value), false);
});
