import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClassicIncrementalRevision,
  verifyClassicIncrementalRevision,
} from '../scripts/host/pdf-classic-incremental-revision.mjs';
import {
  parseClassicPdfStructure,
} from '../scripts/host/pdf-classic-structure.mjs';

function fixture({ id = true } = {}) {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const info = '2 0 obj\n<< /Title (Old) >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const infoOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xrefOffset = infoOffset + Buffer.byteLength(info, 'latin1');
  const idEntry = id
    ? ` /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>]`
    : '';
  const xref = `xref\n0 3\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n${String(infoOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R /Info 2 0 R${idEntry} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${catalog}${info}${xref}`, 'latin1');
}

function fixtureWithUnallocatedGap() {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const xrefOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xref = `xref\n0 2\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${catalog}${xref}`, 'latin1');
}

const ref = (object, generation = 0) => ({ type: 'ref', object, generation });
const name = (value) => ({ type: 'name', value });
const number = (value) => ({ type: 'number', value, integer: true, raw: String(value) });
const text = (value) => ({ type: 'string', bytes: Buffer.from(value, 'utf8') });
const dict = (entries) => ({ type: 'dict', entries: new Map(entries) });

function build(source, options = {}) {
  const structure = parseClassicPdfStructure(source);
  return {
    structure,
    revision: buildClassicIncrementalRevision({
      sourceBytes: source,
      sourceStructure: structure,
      records: [{ reference: ref(3), value: dict([['Title', text('New')]]) }],
      effectiveSize: 4,
      infoReference: ref(3),
      changingId: structure.id ? Buffer.alloc(16, 0x33) : null,
      ...options,
    }),
  };
}

test('builder frames and independently verifies a deterministic fresh-object revision', () => {
  const source = fixture();
  const first = build(source);
  const second = build(source);
  assert.deepEqual(first.revision.bytes, second.revision.bytes);
  assert.equal(Object.isFrozen(first.revision), true);
  assert.equal(Object.isFrozen(first.revision.records), true);
  assert.match(first.revision.bytes.toString('latin1'), /^\n3 0 obj\n/);
  assert.match(first.revision.bytes.toString('latin1'), /xref\n3 1\n/);
  assert.match(first.revision.bytes.toString('latin1'), /\/Prev \d+ >>\nstartxref\n/);
  const output = Buffer.concat([source, first.revision.bytes]);
  const proof = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: output,
    sourceStructure: first.structure,
    expectedRevision: first.revision,
  });
  assert.equal(proof.sourcePrefixPreserved, true);
  assert.equal(proof.unchangedObjectOffsetsPreserved, true);
  assert.equal(proof.idPolicy, 'permanent-preserved-changing-updated');
});

test('builder supports one existing replacement plus contiguous new objects', () => {
  const source = fixture({ id: false });
  const structure = parseClassicPdfStructure(source);
  const revision = buildClassicIncrementalRevision({
    sourceBytes: source,
    sourceStructure: structure,
    records: [
      { reference: ref(1), value: dict([['Type', name('Catalog')], ['Marker', ref(3)]]) },
      { reference: ref(3), value: dict([['Kind', name('Measure')]]) },
      { reference: ref(4), value: dict([['Kind', name('Viewport')]]) },
    ],
    effectiveSize: 5,
    infoReference: structure.info,
    changingId: null,
  });
  const tail = revision.bytes.toString('latin1');
  assert.match(tail, /xref\n1 1\n[0-9]{10} 00000 n \n3 1\n/);
  assert.doesNotMatch(tail, /\/ID/);
  const result = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, revision.bytes]),
    sourceStructure: structure,
    expectedRevision: revision,
  });
  assert.equal(result.outputStructure.finalSize, 5);
  assert.equal(result.outputStructure.effective.get(2).offset, structure.effective.get(2).offset);
});

test('builder rejects post-update Root and Info roles that its verifier cannot parse', () => {
  const source = fixture({ id: false }); const structure = parseClassicPdfStructure(source);
  const base = { sourceBytes: source, sourceStructure: structure, changingId: null };
  const cases = [
    { records: [{ reference: ref(1), value: dict([]) }], effectiveSize: 3, infoReference: structure.info },
    { records: [{ reference: ref(1), value: dict([['Type', name('Catalog')], ['Perms', dict([])]]) }], effectiveSize: 3, infoReference: structure.info },
    { records: [{ reference: ref(1), value: dict([['Type', name('Catalog')]]), streamBytes: Buffer.from('x') }], effectiveSize: 3, infoReference: structure.info },
    { records: [{ reference: ref(2), value: number(1) }], effectiveSize: 3, infoReference: structure.info },
    { records: [{ reference: ref(2), value: dict([]), streamBytes: Buffer.from('x') }], effectiveSize: 3, infoReference: structure.info },
    { records: [{ reference: ref(3), value: dict([]), streamBytes: Buffer.from('x') }], effectiveSize: 4, infoReference: ref(3) },
  ];
  for (const candidate of cases) assert.throws(
    () => buildClassicIncrementalRevision({ ...base, ...candidate }),
    { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' },
  );
});

test('builder rejects ambiguous replacements, allocations, Info, IDs, and object values', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const base = {
    sourceBytes: source,
    sourceStructure: structure,
    effectiveSize: 3,
    infoReference: structure.info,
    changingId: Buffer.alloc(16),
  };
  const invalidRecords = [
    [{ reference: ref(2, 1), value: dict([]) }],
    [{ reference: ref(3, 1), value: dict([]) }],
    [{ reference: ref(4), value: dict([]) }],
    [
      { reference: ref(2), value: dict([]) },
      { reference: ref(1), value: dict([['Type', name('Catalog')]]) },
    ],
    [
      { reference: ref(1), value: dict([['Type', name('Catalog')]]) },
      { reference: ref(1), value: dict([['Type', name('Catalog')]]) },
    ],
  ];
  for (const records of invalidRecords) assert.throws(
    () => buildClassicIncrementalRevision({ ...base, records }),
    { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' },
  );
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(2), value: dict([]) }],
    effectiveSize: 4,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(2), value: dict([]) }],
    infoReference: ref(1),
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(2), value: dict([]) }],
    changingId: null,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(2), value: dict([['Dangling', ref(9)]]) }],
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  const cyclic = dict([]);
  cyclic.entries.set('Cycle', cyclic);
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(2), value: cyclic }],
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
});

test('builder writes and verifies arbitrary bounded non-stream object values', () => {
  const source = fixture({ id: false });
  const structure = parseClassicPdfStructure(source);
  const revision = buildClassicIncrementalRevision({
    sourceBytes: source,
    sourceStructure: structure,
    records: [{
      reference: ref(3),
      value: Object.freeze({
        type: 'array',
        values: Object.freeze([name('GeneralObject'), ref(1)]),
      }),
    }],
    effectiveSize: 4,
    infoReference: structure.info,
    changingId: null,
  });
  const result = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, revision.bytes]),
    sourceStructure: structure,
    expectedRevision: revision,
  });
  assert.equal(result.outputStructure.objects.get(
    `3:0:${revision.records[0].offset}`,
  ).value.type, 'array');
});

test('builder writes opaque binary stream bytes with a canonical direct Length', () => {
  const source = fixture({ id: false });
  const structure = parseClassicPdfStructure(source);
  const streamBytes = Buffer.from([0x00, 0xff, 0x0a, 0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]);
  const revision = buildClassicIncrementalRevision({
    sourceBytes: source,
    sourceStructure: structure,
    records: [{
      reference: ref(3),
      value: dict([['Length', { type: 'number', value: 1, integer: true, raw: '1' }]]),
      streamBytes,
    }],
    effectiveSize: 4,
    infoReference: structure.info,
    changingId: null,
  });
  streamBytes.fill(0x41);
  const outputBytes = Buffer.concat([source, revision.bytes]);
  const result = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: revision,
  });
  const object = result.outputStructure.objects.get(
    `3:0:${revision.records[0].offset}`,
  );
  assert.equal(object.stream, true);
  assert.equal(object.streamLength, 12);
  assert.equal(object.value.entries.get('Length').value, 12);
  assert.deepEqual(
    outputBytes.subarray(object.streamStart, object.streamStart + object.streamLength),
    Buffer.from([0x00, 0xff, 0x0a, 0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]),
  );
});

test('builder preserves an explicit zero-length stream as distinct from a non-stream object', () => {
  const source = fixture({ id: false });
  const structure = parseClassicPdfStructure(source);
  const revision = buildClassicIncrementalRevision({
    sourceBytes: source,
    sourceStructure: structure,
    records: [{ reference: ref(3), value: dict([]), streamBytes: Buffer.alloc(0) }],
    effectiveSize: 4,
    infoReference: structure.info,
    changingId: null,
  });
  const outputBytes = Buffer.concat([source, revision.bytes]);
  const result = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: revision,
  });
  const object = result.outputStructure.objects.get(
    `3:0:${revision.records[0].offset}`,
  );
  assert.equal(object.stream, true);
  assert.equal(object.streamLength, 0);
  assert.equal(object.value.entries.get('Length').value, 0);
  assert.match(revision.bytes.toString('latin1'), /\/Length 0 >>\nstream\n\nendstream/u);
});

test('builder snapshots data properties and rejects incoherent numeric AST values', () => {
  const source = fixture({ id: false });
  const structure = parseClassicPdfStructure(source);
  const changingReference = {};
  Object.defineProperties(changingReference, {
    type: { enumerable: true, value: 'ref' },
    object: { enumerable: true, get: () => 1 },
    generation: { enumerable: true, value: 0 },
  });
  const base = {
    sourceBytes: source,
    sourceStructure: structure,
    effectiveSize: 4,
    infoReference: structure.info,
    changingId: null,
  };
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(3), value: dict([['Reference', changingReference]]) }],
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  const accessorStream = { reference: ref(3), value: dict([]) };
  Object.defineProperty(accessorStream, 'streamBytes', {
    enumerable: true,
    get: () => Buffer.from('unsafe'),
  });
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [accessorStream],
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  const inheritedRecord = Object.assign(Object.create({ unsafe: true }), {
    reference: ref(3), value: dict([]),
  });
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [inheritedRecord],
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  let arrayAccessorCalls = 0;
  const accessorRecords = [];
  Object.defineProperty(accessorRecords, 0, {
    enumerable: true,
    get() { arrayAccessorCalls += 1; return { reference: ref(3), value: dict([]) }; },
  });
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: accessorRecords,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  assert.equal(arrayAccessorCalls, 0);
  const inheritedArray = [{ reference: ref(3), value: dict([]) }];
  Object.setPrototypeOf(inheritedArray, {});
  assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: inheritedArray,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
  for (const value of [
    { type: 'number', value: 1, integer: true, raw: '2' },
    { type: 'number', value: 1.5, integer: true, raw: '1.5' },
  ]) assert.throws(() => buildClassicIncrementalRevision({
    ...base,
    records: [{ reference: ref(3), value }],
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });
});

test('builder stops at the aggregate append budget while normalizing records', () => {
  const source = fixture({ id: false });
  const structure = parseClassicPdfStructure(source);
  const records = Array.from({ length: 17 }, (_, index) => ({
    reference: ref(3 + index),
    value: text('x'.repeat(64 * 1024)),
  }));
  assert.throws(() => buildClassicIncrementalRevision({
    sourceBytes: source,
    sourceStructure: structure,
    records,
    effectiveSize: 20,
    infoReference: structure.info,
    changingId: null,
  }), { code: 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED' });
});

test('verifier rejects prefix, canonical tail, and descriptor mutation', () => {
  const source = fixture();
  const { structure, revision } = build(source);
  const output = Buffer.concat([source, revision.bytes]);
  const prefix = Buffer.from(output);
  prefix[10] ^= 1;
  const tail = Buffer.from(output);
  tail[source.length + 4] ^= 1;
  for (const candidate of [prefix, tail, Buffer.concat([output, Buffer.from(' ')])]) {
    assert.throws(() => verifyClassicIncrementalRevision({
      sourceBytes: source,
      outputBytes: candidate,
      sourceStructure: structure,
      expectedRevision: revision,
    }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
  }
  revision.bytes[1] ^= 1;
  assert.throws(() => verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: output,
    sourceStructure: structure,
    expectedRevision: revision,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
});

test('builder and verifier reparse source bytes instead of trusting mutable parser maps', () => {
  const gapSource = fixtureWithUnallocatedGap();
  const mutatedGap = parseClassicPdfStructure(gapSource);
  mutatedGap.effective.set(2, {
    object: 2,
    generation: 0,
    status: 'n',
    offset: 9,
  });
  assert.throws(() => buildClassicIncrementalRevision({
    sourceBytes: gapSource,
    sourceStructure: mutatedGap,
    records: [{ reference: ref(2), value: dict([['Marker', name('Unsafe')]]) }],
    effectiveSize: 3,
    infoReference: null,
    changingId: null,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_REVISION' });

  const source = fixture();
  const { structure, revision } = build(source);
  structure.effective.clear();
  const result = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, revision.bytes]),
    sourceStructure: structure,
    expectedRevision: revision,
  });
  assert.equal(result.sourcePrefixPreserved, true);
});
