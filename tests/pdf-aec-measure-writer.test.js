import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAecFinalOutput } from '../scripts/host/aec-measure-embedding.mjs';
import { normalizeAecMeasureDictionaryInput } from '../scripts/host/pdf-aec-measure-contract.mjs';
import {
  validateAecOutputEnvelope,
  validateAecParsedOutput,
} from '../scripts/host/pdf-aec-measure-output-validation.mjs';
import {
  inspectIncrementalAecMeasureDictionary,
  writeIncrementalAecMeasureDictionary,
} from '../scripts/host/pdf-aec-measure-writer.mjs';
import {
  pdfDictionary,
  pdfReference,
  pdfStringBytes,
} from '../scripts/host/pdf-classic-syntax.mjs';
import {
  parsePdfStructure,
  parseClassicPdfStructure,
  resolvePdfObject,
  resolveClassicPdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';

function classicPdf({ annotation, pageExtra = '' } = {}) {
  const bodies = [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 3 0 R /Annots 4 0 R${pageExtra} >>`,
    '<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [1 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '[5 0 R]',
    annotation,
    '<< /Type /Catalog /Pages 2 0 R >>',
  ];
  const chunks = ['%PDF-1.3\n'];
  const offsets = [0];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${bodies.length + 1} /Root 6 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function measurement(kind = 'distance') {
  const points = kind === 'distance'
    ? [{ x: 72, y: 72 }, { x: 144, y: 72 }]
    : [{ x: 72, y: 72 }, { x: 144, y: 72 }, { x: 144, y: 144 }];
  const metersPerPdfPoint = 0.3048 / 72;
  const siValue = kind === 'area'
    ? 72 * 72 / 2 * metersPerPdfPoint ** 2
    : kind === 'perimeter'
      ? (72 + 72 + Math.hypot(72, 72)) * metersPerPdfPoint
      : 72 * metersPerPdfPoint;
  return {
    measurement: {
      id: 'measurement-1', kind, calibrationId: 'calibration-1', label: 'Measured wall',
      source: { page: 1, box: { left: 0, bottom: 0, right: 612, top: 792 } },
      geometry: { space: 'pdf-user-space-v1', points },
      result: { siValue, siUnit: kind === 'area' ? 'm2' : 'm' },
    },
    calibration: {
      id: 'calibration-1', segment: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
      knownLength: { value: 1, unit: 'ft' }, metersPerPdfPoint,
    },
  };
}

function resolvedOutput(bytes) {
  const structure = parseClassicPdfStructure(bytes);
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value);
  const pages = pdfDictionary(resolveClassicPdfObject(structure, pdfReference(catalog.get('Pages'))).value);
  const pageRef = pdfReference(pages.get('Kids').values[0]);
  const page = pdfDictionary(resolveClassicPdfObject(structure, pageRef).value);
  const annotationsValue = page.get('Annots');
  const annotations = annotationsValue.type === 'ref'
    ? resolveClassicPdfObject(structure, pdfReference(annotationsValue)).value : annotationsValue;
  const annotationRef = pdfReference(annotations.values.at(-1));
  const annotation = pdfDictionary(resolveClassicPdfObject(structure, annotationRef).value);
  return { structure, catalog, page, annotation };
}

function validationFixture() {
  const sourceBytes = classicPdf({
    annotation: '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>',
  });
  const request = measurement();
  const input = normalizeAecMeasureDictionaryInput(request);
  const written = writeIncrementalAecMeasureDictionary(sourceBytes, request);
  const source = parsePdfStructure(sourceBytes);
  const output = parsePdfStructure(written.bytes);
  const revision = output.revisions[0];
  const records = revision.entries.map((entry) => {
    const reference = Object.freeze({
      type: 'ref', object: entry.object, generation: entry.generation,
    });
    const value = output.objects.get(`${entry.object}:${entry.generation}:${entry.offset}`).value;
    return Object.freeze({ reference, value });
  });
  const append = Object.freeze({
    xrefOffset: revision.offset,
    records: Object.freeze(records),
    offsets: Object.freeze(revision.entries.map((entry) => entry.offset)),
  });
  return { sourceBytes, outputBytes: written.bytes, input, source, output, append };
}

const INVALID_OUTPUT = Object.freeze({
  code: 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT',
  message: 'The incremental AEC measure-dictionary output proof failed.',
});

test('writer appends one calibrated viewport and binds a distance line to the same Measure dictionary', () => {
  const source = classicPdf({
    annotation: '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] /Contents (AEC distance) >>',
  });
  const input = measurement();
  const result = writeIncrementalAecMeasureDictionary(source, input);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.proof.sourcePrefixPreserved, true);
  assert.equal(result.proof.measurementDictionaryScope, 'line-and-page-viewport');
  assert.deepEqual(inspectIncrementalAecMeasureDictionary(source, result.bytes, input), result.proof);

  const { structure, catalog, page, annotation } = resolvedOutput(result.bytes);
  assert.equal(catalog.get('Version').type, 'name');
  assert.equal(catalog.get('Version').value, '1.7');
  const viewportRef = pdfReference(page.get('VP').values[0]);
  const viewport = pdfDictionary(resolveClassicPdfObject(structure, viewportRef).value);
  assert.equal(viewport.get('Type').value, 'Viewport');
  assert.deepEqual(viewport.get('BBox').values.map((value) => value.value), [0, 0, 612, 792]);
  const measureRef = pdfReference(viewport.get('Measure'));
  assert.deepEqual(pdfReference(annotation.get('Measure')), measureRef);
  assert.equal(annotation.get('IT').value, 'LineDimension');

  const measure = pdfDictionary(resolveClassicPdfObject(structure, measureRef).value);
  assert.equal(measure.get('Type').value, 'Measure');
  assert.equal(measure.get('Subtype').value, 'RL');
  assert.equal(pdfStringBytes(measure.get('R')).toString('ascii'), '72 pt = 1 ft');
  const xFormat = pdfDictionary(measure.get('X').values[0]);
  const distanceFormat = pdfDictionary(measure.get('D').values[0]);
  const areaFormat = pdfDictionary(measure.get('A').values[0]);
  assert.equal(xFormat.get('Type').value, 'NumberFormat');
  assert.equal(xFormat.get('C').value, 0.3048 / 72);
  assert.equal(pdfStringBytes(xFormat.get('U')).toString('ascii'), 'm');
  assert.equal(distanceFormat.get('C').value, 1);
  assert.equal(pdfStringBytes(distanceFormat.get('U')).toString('ascii'), 'm');
  assert.equal(areaFormat.get('C').value, 1);
  assert.equal(pdfStringBytes(areaFormat.get('U')).toString('ascii'), 'm2');
});

test('writer expands exponent-form calibration numbers into canonical PDF decimals', () => {
  const source = classicPdf({
    annotation: '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>',
  });
  const input = measurement();
  input.calibration.knownLength.value = 1e-7;
  input.calibration.metersPerPdfPoint = 1e-7 * 0.3048 / 72;
  input.measurement.result.siValue = 72 * input.calibration.metersPerPdfPoint;

  const result = writeIncrementalAecMeasureDictionary(source, input);
  const { structure, page } = resolvedOutput(result.bytes);
  const viewport = pdfDictionary(resolveClassicPdfObject(
    structure, pdfReference(page.get('VP').values[0]),
  ).value);
  const measure = pdfDictionary(resolveClassicPdfObject(
    structure, pdfReference(viewport.get('Measure')),
  ).value);
  const xFormat = pdfDictionary(measure.get('X').values[0]);

  assert.equal(xFormat.get('C').raw, '0.0000000004233333333333333');
  assert.equal(pdfStringBytes(measure.get('R')).toString('ascii'), '72 pt = 0.0000001 ft');
});

test('writer calibrates an ink perimeter through the page viewport without inventing unsupported Ink keys', () => {
  const source = classicPdf({
    annotation: '<< /Type /Annot /Subtype /Ink /Rect [71.5 71.5 144.5 144.5] /InkList [[72 72 144 72 144 144 72 72]] /Contents (AEC perimeter) >>',
  });
  const input = measurement('perimeter');
  const result = writeIncrementalAecMeasureDictionary(source, input);
  assert.equal(result.proof.measurementDictionaryScope, 'page-viewport');
  const { annotation, page } = resolvedOutput(result.bytes);
  assert.equal(page.has('VP'), true);
  assert.equal(annotation.has('Measure'), false);
  assert.equal(annotation.has('IT'), false);
});

test('writer fails closed on existing measurement contexts, active or mismatched markups, and tampered append bytes', () => {
  const line = '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>';
  const input = measurement();
  assert.throws(
    () => writeIncrementalAecMeasureDictionary(classicPdf({ annotation: line, pageExtra: ' /VP []' }), input),
    { code: 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF' },
  );
  assert.throws(
    () => writeIncrementalAecMeasureDictionary(classicPdf({ annotation: line.replace(' >>', ' /A << /S /URI >> >>') }), input),
    { code: 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF' },
  );
  assert.throws(
    () => writeIncrementalAecMeasureDictionary(classicPdf({ annotation: line.replace('144 72', '145 72') }), input),
    { code: 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF' },
  );
  const source = classicPdf({ annotation: line });
  const output = writeIncrementalAecMeasureDictionary(source, input).bytes;
  const tampered = Buffer.from(output);
  tampered[source.length + 5] ^= 1;
  assert.throws(
    () => inspectIncrementalAecMeasureDictionary(source, tampered, input),
    { code: 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT' },
  );
});

test('writer validation is deterministic and rejects prefix, append, revision, object, entry, and ID mutations for Line and Ink', () => {
  const cases = [
    {
      name: 'Line',
      annotation: '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>',
      input: measurement(),
    },
    {
      name: 'Ink',
      annotation: '<< /Type /Annot /Subtype /Ink /Rect [71.5 71.5 144.5 144.5] /InkList [[72 72 144 72 144 144 72 72]] >>',
      input: measurement('perimeter'),
    },
  ];
  for (const { name, annotation, input } of cases) {
    const source = classicPdf({ annotation });
    const first = writeIncrementalAecMeasureDictionary(source, input);
    const second = writeIncrementalAecMeasureDictionary(source, input);
    assert.deepEqual(second.bytes, first.bytes, `${name} append bytes must be canonical`);
    assert.deepEqual(second.proof, first.proof, `${name} proof must be canonical`);
    assert.deepEqual(inspectIncrementalAecMeasureDictionary(source, first.bytes, input), first.proof);

    const appendOffset = source.length;
    const trailerOffset = first.bytes.indexOf(Buffer.from('trailer\n', 'ascii'), appendOffset);
    const objectOffset = first.bytes.indexOf(Buffer.from(' obj\n', 'ascii'), appendOffset);
    const effectiveEntryOffset = first.bytes.indexOf(Buffer.from(' 00000 n \n', 'ascii'), appendOffset);
    const changedIdOffset = first.bytes.lastIndexOf(Buffer.from('<', 'ascii')) + 1;
    assert.notEqual(trailerOffset, -1);
    assert.notEqual(objectOffset, -1);
    assert.notEqual(effectiveEntryOffset, -1);
    assert.ok(changedIdOffset > appendOffset);
    const mutations = [
      ['source prefix', 0],
      ['append byte', appendOffset],
      ['trailer', trailerOffset],
      ['object', objectOffset + 1],
      ['effective entry', effectiveEntryOffset + 7],
      ['changing ID', changedIdOffset],
    ];
    for (const [label, offset] of mutations) {
      const mutated = Buffer.from(first.bytes);
      mutated[offset] = mutated[offset] === 0x30 ? 0x31 : 0x30;
      assert.throws(
        () => inspectIncrementalAecMeasureDictionary(source, mutated, input),
        { code: 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT' },
        `${name} ${label} mutation must fail closed`,
      );
    }
  }
});

test('output validators independently reject envelope, revision, record, effective-entry, and ID drift', () => {
  const fixture = validationFixture();
  const {
    sourceBytes, outputBytes, input, source, output, append,
  } = fixture;
  assert.doesNotThrow(() => validateAecOutputEnvelope(sourceBytes, outputBytes));
  assert.equal(validateAecParsedOutput(fixture), output);

  const wrongPrefix = Buffer.from(outputBytes);
  wrongPrefix[0] ^= 1;
  assert.throws(() => validateAecOutputEnvelope(sourceBytes, wrongPrefix), INVALID_OUTPUT);

  assert.throws(
    () => validateAecParsedOutput({
      ...fixture, append: { ...append, xrefOffset: append.xrefOffset + 1 },
    }),
    INVALID_OUTPUT,
  );

  const wrongOffsets = [...append.offsets];
  wrongOffsets[0] += 1;
  assert.throws(
    () => validateAecParsedOutput({
      ...fixture, append: { ...append, offsets: wrongOffsets },
    }),
    INVALID_OUTPUT,
  );

  const retained = [...source.effective].find(([number, entry]) => (
    entry.status === 'n' && !append.records.some((record) => record.reference.object === number)
  ));
  assert.ok(retained);
  const [retainedNumber] = retained;
  const retainedOutputEntry = output.effective.get(retainedNumber);
  output.effective.delete(retainedNumber);
  assert.throws(
    () => validateAecParsedOutput(fixture),
    INVALID_OUTPUT,
  );
  output.effective.set(retainedNumber, retainedOutputEntry);

  output.id[1][0] ^= 1;
  assert.throws(
    () => validateAecParsedOutput(fixture),
    INVALID_OUTPUT,
  );
  output.id[1][0] ^= 1;
});

test('private embedding preserves the native intermediate and binds both output digests', async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), 'platen-aec-measure-'));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const outputPath = join(workspace, 'output.pdf');
  const finalOutputPath = join(workspace, 'measured-output.pdf');
  const source = classicPdf({
    annotation: '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>',
  });
  writeFileSync(outputPath, source, { mode: 0o600 });
  chmodSync(outputPath, 0o400);
  const nativeOutputSha256 = createHash('sha256').update(source).digest('hex');
  const embedded = await createAecFinalOutput({
    nativeOutputPath: outputPath,
    finalOutputPath,
    nativeOutputSha256,
    measurement: measurement().measurement,
    calibration: measurement().calibration,
    maximumSourceBytes: 1024 * 1024,
    maximumOutputBytes: 2 * 1024 * 1024,
  });
  const output = readFileSync(finalOutputPath);
  assert.deepEqual(readdirSync(workspace).sort(), ['measured-output.pdf', 'output.pdf']);
  assert.equal(readFileSync(outputPath).equals(source), true);
  assert.equal(embedded.nativeOutputSha256, nativeOutputSha256);
  assert.equal(embedded.outputSha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(embedded.proof.measurementDictionaryScope, 'line-and-page-viewport');
  assert.equal(output.subarray(0, source.length).equals(source), true);
});
