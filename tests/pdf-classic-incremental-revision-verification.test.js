import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClassicIncrementalRevision,
  verifyIncrementalWrittenRecords,
} from '../scripts/host/pdf-classic-incremental-revision.mjs';
import {
  parseClassicPdfStructure,
  parsePdfStructure,
} from '../scripts/host/pdf-classic-structure.mjs';

function fixture() {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const info = '2 0 obj\n<< /Title (Old) >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const infoOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xrefOffset = infoOffset + Buffer.byteLength(info, 'latin1');
  const xref = `xref\n0 3\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n${String(infoOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R /Info 2 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${catalog}${info}${xref}`, 'latin1');
}

const ref = (object, generation = 0) => ({ type: 'ref', object, generation });
const text = (value) => ({ type: 'string', bytes: Buffer.from(value, 'utf8') });
const dict = (entries) => ({ type: 'dict', entries: new Map(entries) });

test('written-record verification checks each xref and object-stream equality axis', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const revision = buildClassicIncrementalRevision({
    sourceBytes: source,
    sourceStructure: structure,
    records: [{ reference: ref(3), value: dict([['Label', text('Original')]]), streamBytes: Buffer.from('abc') }],
    effectiveSize: 4,
    infoReference: ref(2),
    changingId: null,
  });
  const outputBytes = Buffer.concat([source, revision.bytes]);
  const output = parsePdfStructure(outputBytes);
  const [record] = revision.records;
  const entry = output.revisions[0].entries[0];
  assert.doesNotThrow(() => verifyIncrementalWrittenRecords(output, [record]));
  for (const patch of [
    { object: entry.object + 1 },
    { generation: entry.generation + 1 },
    { offset: entry.offset + 1 },
    { status: 'f' },
  ]) assert.throws(() => verifyIncrementalWrittenRecords(
    output, [record], new Map([[record.reference.object, { ...entry, ...patch }]]),
  ), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });

  const stream = output.objects.get(
    `${record.reference.object}:${record.reference.generation}:${record.offset}`,
  );
  output.buffer[stream.streamStart] ^= 1;
  assert.throws(() => verifyIncrementalWrittenRecords(output, [record]), {
    code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT',
  });

  const bodyBytes = Buffer.from(outputBytes);
  bodyBytes[bodyBytes.indexOf('Original', source.length, 'latin1')] = 0x58;
  const bodyOutput = parsePdfStructure(bodyBytes);
  assert.throws(() => verifyIncrementalWrittenRecords(bodyOutput, [record]), {
    code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT',
  });
});
