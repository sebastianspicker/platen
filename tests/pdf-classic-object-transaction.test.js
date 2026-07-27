import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  pendingClassicObjectReference,
  planClassicObjectTransaction,
} from '../scripts/host/pdf-classic-object-transaction.mjs';
import {
  verifyClassicIncrementalRevision,
} from '../scripts/host/pdf-classic-incremental-revision.mjs';
import {
  parseClassicPdfStructure,
  resolveClassicPdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';

const execFileAsync = promisify(execFile);

function fixture({ id = false } = {}) {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const info = '2 0 obj\n<< /Title (Old) >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const infoOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xrefOffset = infoOffset + Buffer.byteLength(info, 'latin1');
  const idEntry = id ? ` /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>]` : '';
  return Buffer.from(`${header}${catalog}${info}xref\n0 3\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n${String(infoOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R /Info 2 0 R${idEntry} >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

function streamFixture() {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog /ContentProbe 3 0 R >>\nendobj\n';
  const stream = '3 0 obj\n<< /Length 3 /Subtype /Binary >>\nstream\nold\nendstream\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const streamOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xrefOffset = streamOffset + Buffer.byteLength(stream, 'latin1');
  return Buffer.from(`${header}${catalog}${stream}xref\n0 4\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n0000000000 00000 f \n${String(streamOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

const ref = (object, generation = 0) => Object.freeze({ type: 'ref', object, generation });
const name = (value) => Object.freeze({ type: 'name', value });
const number = (value) => Object.freeze({ type: 'number', value, integer: true, raw: String(value) });
const text = (value) => Object.freeze({ type: 'string', bytes: Buffer.from(value) });
const array = (values) => Object.freeze({ type: 'array', values: Object.freeze(values) });
const dict = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });

function request(source, structure, overrides = {}) {
  return {
    sourceBytes: source,
    sourceStructure: structure,
    updates: [],
    additions: [{ id: 'added', value: dict([['Kind', name('Added')]]) }],
    info: { kind: 'preserve' },
    changingId: structure.id ? Buffer.alloc(16, 0x33) : null,
    ...overrides,
  };
}

test('planner allocates named objects and resolves forward and backward pending references', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const first = pendingClassicObjectReference('first');
  const second = pendingClassicObjectReference('second');
  const plan = planClassicObjectTransaction(request(source, structure, {
    updates: [{
      reference: ref(1),
      value: dict([['Type', name('Catalog')], ['Marker', first]]),
    }],
    additions: [
      { id: 'first', value: array([name('GeneralObject'), second]) },
      { id: 'second', value: dict([['Back', first]]) },
    ],
  }));

  assert.deepEqual(plan.referencesById.first, ref(3));
  assert.deepEqual(plan.referencesById.second, ref(4));
  assert.equal(plan.effectiveSize, 5);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.referencesById), true);
  assert.throws(() => { plan.referencesById.first = ref(9); }, TypeError);

  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const proof = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  assert.equal(resolveClassicPdfObject(
    proof.outputStructure, plan.referencesById.first,
  ).value.type, 'array');
  assert.equal(resolveClassicPdfObject(
    proof.outputStructure, plan.referencesById.second,
  ).value.entries.get('Back').object, 3);
});

test('planner can bind a newly allocated dictionary as the Info object', () => {
  const source = fixture({ id: true });
  const structure = parseClassicPdfStructure(source);
  const plan = planClassicObjectTransaction(request(source, structure, {
    additions: [{ id: 'info', value: dict([['Title', text('New')]]) }],
    info: { kind: 'set', additionId: 'info' },
  }));
  const proof = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, plan.revision.bytes]),
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  assert.deepEqual(proof.outputStructure.info, plan.referencesById.info);
  assert.equal(plan.revision.idPolicy, 'permanent-preserved-changing-updated');
});

test('planner rejects invalid effective Root and streamed Info roles before returning bytes', () => {
  const source = fixture(); const structure = parseClassicPdfStructure(source);
  for (const overrides of [
    { updates: [{ reference: ref(1), value: dict([]) }], additions: [] },
    { updates: [{ reference: ref(1), value: dict([['Type', name('Catalog')]]), streamBytes: Buffer.from('x') }], additions: [] },
    { additions: [{ id: 'info', value: dict([]), streamBytes: Buffer.from('x') }], info: { kind: 'set', additionId: 'info' } },
  ]) assert.throws(
    () => planClassicObjectTransaction(request(source, structure, overrides)),
    { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' },
  );
});

test('planner adds bounded binary streams and canonicalizes their direct Length', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const content = Buffer.from([0x00, 0x0a, 0xff, ...Buffer.from('endstream\nopaque', 'latin1')]);
  const pending = pendingClassicObjectReference('content');
  const plan = planClassicObjectTransaction(request(source, structure, {
    updates: [{
      reference: ref(1),
      value: dict([['Type', name('Catalog')], ['ContentProbe', pending]]),
    }],
    additions: [{
      id: 'content',
      value: dict([['Length', number(999)], ['Subtype', name('Binary')]]),
      streamBytes: content,
    }],
  }));
  content.fill(0x41);
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const proof = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  const object = resolveClassicPdfObject(proof.outputStructure, plan.referencesById.content);
  assert.equal(object.stream, true);
  assert.equal(object.streamLength, 19);
  assert.equal(object.value.entries.get('Length').value, 19);
  assert.deepEqual(
    outputBytes.subarray(object.streamStart, object.streamStart + object.streamLength),
    Buffer.from([0x00, 0x0a, 0xff, ...Buffer.from('endstream\nopaque', 'latin1')]),
  );
  const record = plan.revision.records.find(({ reference }) => reference.object === 3);
  assert.equal(record.streamLength, 19);
  assert.match(record.streamSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(record, 'streamBytes'), false);
});

test('planner replaces an existing stream without reallocating unrelated objects', () => {
  const source = streamFixture();
  const structure = parseClassicPdfStructure(source);
  const priorCatalogOffset = structure.effective.get(1).offset;
  const replacement = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const plan = planClassicObjectTransaction(request(source, structure, {
    updates: [{
      reference: ref(3),
      value: dict([['Length', number(3)], ['Subtype', name('Binary')]]),
      streamBytes: replacement,
    }],
    additions: [],
  }));
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const proof = verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  const object = resolveClassicPdfObject(proof.outputStructure, ref(3));
  assert.equal(plan.effectiveSize, structure.finalSize);
  assert.equal(proof.outputStructure.effective.get(1).offset, priorCatalogOffset);
  assert.equal(object.value.entries.get('Length').value, replacement.length);
  assert.deepEqual(
    outputBytes.subarray(object.streamStart, object.streamStart + object.streamLength),
    replacement,
  );
});

test('installed Poppler parses and extracts text from a replaced content stream', async (context) => {
  try {
    await Promise.all(
      ['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)),
    );
  } catch {
    context.skip('The fixed Poppler inspection tools are unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'pdf-classic-stream-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = makeMultiPagePdf(['old stream text']);
  const structure = parseClassicPdfStructure(source);
  const replacement = Buffer.from('BT\n/F1 18 Tf\n72 720 Td\n(replaced stream text) Tj\nET\n', 'latin1');
  const plan = planClassicObjectTransaction(request(source, structure, {
    updates: [{
      reference: ref(5),
      value: resolveClassicPdfObject(structure, ref(5)).value,
      streamBytes: replacement,
    }],
    additions: [],
  }));
  const outputPath = join(directory, 'output.pdf');
  await writeFile(outputPath, Buffer.concat([source, plan.revision.bytes]));
  const [{ stdout: info }, { stdout: textOutput }] = await Promise.all([
    execFileAsync('/opt/homebrew/bin/pdfinfo', [outputPath]),
    execFileAsync('/opt/homebrew/bin/pdftotext', [outputPath, '-']),
  ]);
  assert.match(info, /^Pages:\s+1$/mu);
  assert.equal(textOutput.trim(), 'replaced stream text');
});

test('planner rejects ambiguous records and unbound or forged pending references', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const cases = [
    request(source, structure, { updates: [], additions: [] }),
    request(source, structure, {
      additions: [
        { id: 'same', value: dict([]) },
        { id: 'same', value: dict([]) },
      ],
    }),
    request(source, structure, {
      additions: [{ id: 'added', value: pendingClassicObjectReference('missing') }],
    }),
    request(source, structure, {
      additions: [{ id: 'added', value: { type: 'pending-ref', id: 'added' } }],
    }),
    request(source, structure, {
      updates: [{ reference: ref(1, 1), value: dict([]) }],
    }),
    request(source, structure, {
      updates: [
        { reference: ref(1), value: dict([['Type', name('Catalog')]]) },
        { reference: ref(1), value: dict([['Type', name('Catalog')]]) },
      ],
    }),
    request(source, structure, {
      additions: [{ id: 'info', value: array([]) }],
      info: { kind: 'set', additionId: 'info' },
    }),
    request(source, structure, {
      additions: [{ id: 'stream', value: array([]), streamBytes: Buffer.from('x') }],
    }),
    request(source, structure, {
      additions: [{ id: 'stream', value: dict([]), streamBytes: 'not-bytes' }],
    }),
    { ...request(source, structure), extra: true },
  ];
  for (const candidate of cases) assert.throws(
    () => planClassicObjectTransaction(candidate),
    { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' },
  );
});

test('planner bounds aggregate stream bytes before producing a revision', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [{
      id: 'stream',
      value: dict([]),
      streamBytes: Buffer.alloc(1024 * 1024),
    }],
  })), { code: 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED' });
});

test('planned bytes do not trust later mutations to inputs or parsed maps', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const entries = new Map([['Kind', name('Stable')]]);
  const plan = planClassicObjectTransaction(request(source, structure, {
    additions: [{ id: 'stable', value: dict(entries) }],
  }));
  const before = Buffer.from(plan.revision.bytes);
  entries.set('Changed', name('Later'));
  structure.effective.clear();
  assert.deepEqual(plan.revision.bytes, before);
  assert.equal(verifyClassicIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, plan.revision.bytes]),
    sourceStructure: structure,
    expectedRevision: plan.revision,
  }).sourcePrefixPreserved, true);
});

test('planner rejects accessor-backed records before binding a new Info object', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const addition = { id: 'info' };
  Object.defineProperty(addition, 'value', {
    enumerable: true,
    get: () => dict([['Title', text('Accessor')]]),
  });
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [addition],
    info: { kind: 'set', additionId: 'info' },
  })), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
});

test('planner rejects non-plain transaction records before reading their values', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  const inherited = Object.create({ streamBytes: Buffer.from('unsafe') });
  inherited.id = 'stream';
  inherited.value = dict([]);
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [inherited],
  })), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
});

test('planner rejects a SharedArrayBuffer-backed source before transaction work', () => {
  const source = fixture();
  const shared = Buffer.from(new SharedArrayBuffer(source.length));
  source.copy(shared);
  const structure = parseClassicPdfStructure(shared);
  assert.throws(() => planClassicObjectTransaction(request(shared, structure, {
    additions: [{ id: 'added', value: dict([]) }],
  })), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
});

test('planner bounds compact repeated graphs and excessive nesting before serialization', () => {
  const source = fixture();
  const structure = parseClassicPdfStructure(source);
  let repeated = name('leaf');
  for (let depth = 0; depth < 15; depth += 1) repeated = array([repeated, repeated]);
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [{ id: 'repeated', value: repeated }],
  })), { code: 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED' });

  let nested = name('leaf');
  for (let depth = 0; depth < 18; depth += 1) nested = array([nested]);
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [{ id: 'nested', value: nested }],
  })), { code: 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED' });

  const sharedString = text('x'.repeat(64 * 1024));
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [{ id: 'aliased', value: array(Array(8_192).fill(sharedString)) }],
  })), { code: 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED' });

  const sparseRecords = [];
  sparseRecords.length = 0xffffffff;
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    updates: sparseRecords,
  })), { code: 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED' });
  const sparseValues = [];
  sparseValues.length = 0xffffffff;
  assert.throws(() => planClassicObjectTransaction(request(source, structure, {
    additions: [{ id: 'sparse', value: { type: 'array', values: sparseValues } }],
  })), { code: 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED' });
});
