import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  inspectIncrementalAecMeasureDictionary,
  writeIncrementalAecMeasureDictionary,
} from '../scripts/host/pdf-aec-measure-writer.mjs';
import {
  inspectIncrementalPdfBleedBox,
  writeIncrementalPdfBleedBox,
} from '../scripts/host/pdf-incremental-bleed-box-writer.mjs';
import {
  inspectIncrementalPdfMetadata,
  writeIncrementalPdfMetadata,
} from '../scripts/host/pdf-incremental-metadata-writer.mjs';
import {
  inspectIncrementalPdfAccessibilityMetadata,
  writeIncrementalPdfAccessibilityMetadata,
} from '../scripts/host/pdf-incremental-accessibility-metadata-writer.mjs';
import {
  parsePdfStructure,
  resolvePdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';
import { pdfDictionary, pdfReference } from '../scripts/host/pdf-classic-syntax.mjs';
import {
  makeObjectStreamPdf,
  makeXrefStreamPdf,
} from './support/pdf-xref-stream-fixture.js';

const metadata = Object.freeze({
  title: 'Generic metadata', author: 'Ada', subject: null, keywords: 'xref, object stream',
});
const accessibilityMetadata = Object.freeze({
  language: 'en-us', title: 'Accessible generic source',
});
const bleedRequest = Object.freeze({
  profile: 'local-classic-incremental-bleed-box-v1',
  page: 1,
  rect: Object.freeze({ x: 5, y: 5, width: 90, height: 90 }),
});
const bleedExtra = ' /TrimBox [10 10 90 90] /BleedBox [0 0 100 100]';
const execFileAsync = promisify(execFile);

function xrefRow(type, field2, field3) {
  const bytes = Buffer.alloc(7);
  bytes[0] = type;
  bytes.writeUInt32BE(field2, 1);
  bytes.writeUInt16BE(field3, 5);
  return bytes;
}

function aecObjectStreamPdf() {
  const header = '%PDF-1.7\n';
  const bodies = new Map([
    [1, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 3 0 R /Annots 4 0 R >>'],
    [2, '<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [1 0 R] >>'],
    [3, '<< /Length 0 >>\nstream\n\nendstream'],
    [4, '[5 0 R]'],
    [5, '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>'],
  ]);
  const chunks = [Buffer.from(header, 'latin1')];
  const offsets = new Map();
  for (const [object, value] of bodies) {
    offsets.set(object, Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${object} 0 obj\n${value}\nendobj\n`, 'latin1'));
  }
  const member = Buffer.from('6 0 << /Type /Catalog /Pages 2 0 R >>', 'latin1');
  offsets.set(7, Buffer.concat(chunks).length);
  chunks.push(Buffer.from(`7 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${member.length} >>\nstream\n`, 'latin1'));
  chunks.push(member, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  const xrefOffset = Buffer.concat(chunks).length;
  const rows = Buffer.concat([
    xrefRow(0, 0, 65_535),
    ...[1, 2, 3, 4, 5].map((object) => xrefRow(1, offsets.get(object), 0)),
    xrefRow(2, 7, 0),
    xrefRow(1, offsets.get(7), 0),
    xrefRow(1, xrefOffset, 0),
  ]);
  chunks.push(Buffer.from(`8 0 obj\n<< /Type /XRef /W [1 4 2] /Index [0 9] /Size 9 /Root 6 0 R /Length ${rows.length} >>\nstream\n`, 'latin1'));
  chunks.push(rows, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function measurement() {
  const metersPerPdfPoint = 0.3048 / 72;
  return {
    measurement: {
      id: 'measurement-1', kind: 'distance', calibrationId: 'calibration-1',
      label: 'Measured wall',
      source: { page: 1, box: { left: 0, bottom: 0, right: 612, top: 792 } },
      geometry: {
        space: 'pdf-user-space-v1', points: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
      },
      result: { siValue: 72 * metersPerPdfPoint, siUnit: 'm' },
    },
    calibration: {
      id: 'calibration-1', segment: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
      knownLength: { value: 1, unit: 'ft' }, metersPerPdfPoint,
    },
  };
}

test('metadata writer accepts bounded xref and compressed Info streams', () => {
  const sources = [
    makeXrefStreamPdf({
      xrefFilters: ['RunLengthDecode'], infoValue: '<< /Producer (Fixture) >>',
    }),
    makeObjectStreamPdf({
      compressedCatalog: true,
      objectFilters: ['RunLengthDecode'],
      xrefFilters: ['ASCII85Decode', 'RunLengthDecode'],
      infoValue: '<< /Producer (Fixture) >>',
    }),
  ];
  for (const source of sources) {
    const result = writeIncrementalPdfMetadata(source, metadata);
    assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
    assert.deepEqual(inspectIncrementalPdfMetadata(source, result.bytes, metadata), result.proof);
    const output = parsePdfStructure(result.bytes);
    assert.equal(output.revisions[0].xrefKind, 'classic');
    assert.equal(output.revisions[1].xrefKind, 'stream');
    assert.equal(resolvePdfObject(output, output.info).value.entries.get('Title').type, 'string');
  }
});

test('accessibility metadata writer accepts bounded xref and compressed Catalog streams', () => {
  const sources = [
    makeXrefStreamPdf({
      xrefFilters: ['RunLengthDecode'], infoValue: '<< /Producer (Fixture) >>',
    }),
    makeObjectStreamPdf({
      compressedCatalog: true,
      objectFilters: ['RunLengthDecode'],
      xrefFilters: ['ASCII85Decode', 'RunLengthDecode'],
      infoValue: '<< /Producer (Fixture) >>',
    }),
  ];
  for (const source of sources) {
    const result = writeIncrementalPdfAccessibilityMetadata(source, accessibilityMetadata);
    assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
    assert.deepEqual(
      inspectIncrementalPdfAccessibilityMetadata(
        source, result.bytes, accessibilityMetadata,
      ),
      result.proof,
    );
    const output = parsePdfStructure(result.bytes);
    assert.equal(output.revisions[0].xrefKind, 'classic');
    assert.equal(output.revisions[1].xrefKind, 'stream');
    assert.equal(resolvePdfObject(output, output.info).value.entries.get('Title').type, 'string');
  }
});

test('BleedBox writer shadows one page over xref and compressed-Catalog sources', () => {
  const sources = [
    makeXrefStreamPdf({ pageExtra: bleedExtra, xrefFilters: ['RunLengthDecode'] }),
    makeObjectStreamPdf({
      compressedCatalog: true,
      pageExtra: bleedExtra,
      objectFilters: ['RunLengthDecode'],
      xrefFilters: ['RunLengthDecode'],
    }),
  ];
  for (const source of sources) {
    const result = writeIncrementalPdfBleedBox(source, bleedRequest);
    assert.deepEqual(
      inspectIncrementalPdfBleedBox(source, result.bytes, bleedRequest), result.proof,
    );
    const output = parsePdfStructure(result.bytes);
    const page = pdfDictionary(resolvePdfObject(output, { type: 'ref', object: 5, generation: 0 }).value);
    assert.deepEqual(page.get('BleedBox').values.map(({ value }) => value), [5, 5, 95, 95]);
  }
});

test('AEC writer resolves a compressed Catalog and appends measured objects classically', () => {
  const source = aecObjectStreamPdf();
  const input = measurement();
  const result = writeIncrementalAecMeasureDictionary(source, input);
  assert.deepEqual(inspectIncrementalAecMeasureDictionary(source, result.bytes, input), result.proof);
  const output = parsePdfStructure(result.bytes);
  const catalog = pdfDictionary(resolvePdfObject(output, output.root).value);
  const pages = pdfDictionary(resolvePdfObject(output, pdfReference(catalog.get('Pages'))).value);
  const page = pdfDictionary(resolvePdfObject(output, pdfReference(pages.get('Kids').values[0])).value);
  const viewport = pdfDictionary(resolvePdfObject(output, pdfReference(page.get('VP').values[0])).value);
  assert.equal(viewport.get('Type').value, 'Viewport');
  assert.equal(output.revisions[0].xrefKind, 'classic');
  assert.equal(output.revisions[1].xrefKind, 'stream');
});

test('installed Poppler reopens and renders generic-source writer outputs', async (context) => {
  const pdfinfo = '/opt/homebrew/bin/pdfinfo';
  const pdftocairo = '/opt/homebrew/bin/pdftocairo';
  try { await Promise.all([access(pdfinfo), access(pdftocairo)]); } catch {
    context.skip('The fixed Poppler toolchain is unavailable.');
    return;
  }
  const outputs = [
    writeIncrementalPdfMetadata(makeObjectStreamPdf({
      compressedCatalog: true, objectFilters: ['RunLengthDecode'],
      xrefFilters: ['ASCII85Decode', 'RunLengthDecode'],
    }), metadata).bytes,
    writeIncrementalPdfBleedBox(makeXrefStreamPdf({
      pageExtra: bleedExtra, xrefFilters: ['RunLengthDecode'],
    }), bleedRequest).bytes,
    writeIncrementalAecMeasureDictionary(aecObjectStreamPdf(), measurement()).bytes,
    writeIncrementalPdfAccessibilityMetadata(makeObjectStreamPdf({
      compressedCatalog: true, objectFilters: ['RunLengthDecode'],
      xrefFilters: ['ASCII85Decode', 'RunLengthDecode'],
      infoValue: '<< /Producer (Fixture) >>',
    }), accessibilityMetadata).bytes,
  ];
  const directory = await mkdtemp(join(tmpdir(), 'pdf-generic-writers-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, bytes] of outputs.entries()) {
    const path = join(directory, `output-${index}.pdf`);
    await writeFile(path, bytes);
    const info = await execFileAsync(pdfinfo, [path]);
    assert.match(info.stdout, /^Pages:\s+1$/mu);
    if (index === 0) assert.match(info.stdout, /^Title:\s+Generic metadata$/mu);
    if (index === 3) assert.match(info.stdout, /^Title:\s+Accessible generic source$/mu);
    const renderRoot = join(directory, `render-${index}`);
    await execFileAsync(pdftocairo, [
      '-png', '-singlefile', '-f', '1', '-l', '1', path, renderRoot,
    ]);
    await access(`${renderRoot}.png`);
  }
});
