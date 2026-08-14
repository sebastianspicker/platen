import assert from 'node:assert/strict';
import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createCadPdfDocument, prepareCadPdfDocumentExport } from '../scripts/host/cad-to-pdf-service.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { decodePng } from '../scripts/host/raster-png-codec.mjs';

const dxf = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n612\n21\n792\n0\nENDSEC\n0\nEOF\n');
const vectorDxf = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n12.1234567\n20\n34.9876543\n11\n400.0000004\n21\n500\n0\nENDSEC\n0\nEOF\n');
const info = 'Pages:          1\nEncrypted:      no\nJavaScript:     no\nForm:           none\n';
const page = 'Page    1 size: 612 x 792 pts\nPage    1 rot: 0\n';
const execFile = promisify(executeFile);

const poppler = Object.freeze({
  async execute(operation) {
    if (operation === 'inspectStdin') return { stdout: info };
    if (operation === 'inspectPageStdin') return { stdout: page };
    throw new Error(`unexpected Poppler operation ${operation}`);
  },
});

async function fixture(context, bytes = dxf) {
  const root = await mkdtemp(join(tmpdir(), 'platen-cad-pdf-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const inputs = await new InputAssetStore({ root }).initialize();
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const asset = await inputs.createInput({ stream: Readable.from([bytes]), displayName: 'drawing.dxf', mediaType: 'image/vnd.dxf' });
  return { inputs, documents, asset };
}

test('CAD packet retains exact admitted LINE operators and exports passive evidence', async (context) => {
  const value = await fixture(context, vectorDxf);
  const document = await createCadPdfDocument({ ...value, poppler, assetId: value.asset.id });
  assert.equal(document.operation.type, 'cad-to-pdf');
  assert.deepEqual({ ...document.operation.parameters }, {
    sourceFormat: 'dxf', sourceKind: 'cad', conversionMode: 'platen-dxf-line-subset',
    entityCount: 1, widthPoints: 612, heightPoints: 792,
  });
  const evidence = await prepareCadPdfDocumentExport({ documents: value.documents, poppler, documentId: document.id });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(evidence.bytes.length, document.size);
  assert.deepEqual(evidence.pageGeometry, { page: 1, widthPoints: 612, heightPoints: 792 });
  assert.equal(evidence.entityCount, 1);
  assert.deepEqual(evidence.passiveIndicators, { encrypted: 'no', javascript: 'no', form: 'none' });
  const retained = await readFile(value.documents.getSourcePath(document.id));
  assert.match(retained.toString('latin1'), /12\.123457 34\.987654 m\n400 500 l\nS/u);
});

test('CAD packet rejects strict-encoding, malformed, unsupported, and unsafe DXF values', async (context) => {
  for (const source of [
    Buffer.concat([Buffer.from('\uFEFF', 'utf8'), dxf]),
    Buffer.concat([Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n'), Buffer.from([0xc3, 0x28]), Buffer.from('\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n')]),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n1\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n10\n1\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n8\nlayer\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n-1\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n1e3\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n14400.1\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n'),
    Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nNaN\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n'),
    Buffer.concat([dxf, Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n')]),
    Buffer.concat([dxf, Buffer.from('999\ntrailing\n')]),
  ]) {
    const value = await fixture(context, source);
    await assert.rejects(createCadPdfDocument({ ...value, poppler, assetId: value.asset.id }));
  }
  await assert.rejects(fixture(context, Buffer.concat([dxf, Buffer.from([0])])), { code: 'INVALID_INPUT_SIGNATURE' });
  const exactLimit = Buffer.from(`0\nSECTION\n2\nENTITIES\n${'0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n'.repeat(2_000)}0\nENDSEC\n0\nEOF\n`);
  const accepted = await fixture(context, exactLimit);
  assert.equal((await createCadPdfDocument({ ...accepted, poppler, assetId: accepted.asset.id })).operation.parameters.entityCount, 2_000);
  const tooMany = Buffer.from(`0\nSECTION\n2\nENTITIES\n${'0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n'.repeat(2_001)}0\nENDSEC\n0\nEOF\n`);
  const excessive = await fixture(context, tooMany);
  await assert.rejects(createCadPdfDocument({ ...excessive, poppler, assetId: excessive.asset.id }), { code: 'CAD_ENTITY_LIMIT' });
  const drift = await fixture(context);
  await writeFile(drift.inputs.getSourcePath(drift.asset.id), Buffer.from('tampered\n'));
  await assert.rejects(createCadPdfDocument({ ...drift, poppler, assetId: drift.asset.id }), { code: 'SOURCE_INTEGRITY_FAILED' });
});

test('CAD export rejects forged provenance and retained-artifact drift', async (context) => {
  const value = await fixture(context);
  const document = await createCadPdfDocument({ ...value, poppler, assetId: value.asset.id });
  const forged = { ...document, operation: { ...document.operation, parameters: { ...document.operation.parameters, conversionMode: 'forged' } } };
  const fakeDocuments = {
    getDocument: () => forged,
    createJobWorkspace: value.documents.createJobWorkspace.bind(value.documents),
    cleanupJob: value.documents.cleanupJob.bind(value.documents),
    verifySource: value.documents.verifySource.bind(value.documents),
  };
  await assert.rejects(prepareCadPdfDocumentExport({ documents: fakeDocuments, poppler, documentId: document.id }), { code: 'INVALID_CAD_PDF_DOCUMENT' });
  await writeFile(value.documents.getSourcePath(document.id), Buffer.from('%PDF-tampered\n'));
  await assert.rejects(prepareCadPdfDocumentExport({ documents: value.documents, poppler, documentId: document.id }), { code: 'SOURCE_INTEGRITY_FAILED' });
});

test('post-promotion cancellation revokes the private derived document', async (context) => {
  const value = await fixture(context);
  const controller = new AbortController(); let promoted;
  const original = value.documents.createDocument.bind(value.documents);
  value.documents.createDocument = async (request) => { promoted = await original(request); controller.abort(); return promoted; };
  await assert.rejects(createCadPdfDocument({ ...value, poppler, assetId: value.asset.id, externalSignal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.throws(() => value.documents.getDocument(promoted.id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('installed Poppler and pdftocairo validate a visible retained CAD line', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftocairo'].map(access)); } catch { context.skip('Fixed Poppler tools are unavailable.'); return; }
  const value = await fixture(context);
  const installed = new PopplerAdapter({ registry: new EngineRegistry() });
  const document = await createCadPdfDocument({ ...value, poppler: installed, assetId: value.asset.id });
  const evidence = await prepareCadPdfDocumentExport({ documents: value.documents, poppler: installed, documentId: document.id });
  const raster = join((await mkdtemp(join(tmpdir(), 'platen-cad-raster-'))), 'line');
  context.after(() => rm(raster.slice(0, raster.lastIndexOf('/')), { recursive: true, force: true }));
  await execFile('/opt/homebrew/bin/pdftocairo', ['-png', '-singlefile', '-r', '72', value.documents.getSourcePath(document.id), raster]);
  const image = decodePng(await readFile(`${raster}.png`));
  assert.equal(image.pixels.some((value, index) => index % 4 < 3 && value < 200), true);
  assert.equal(evidence.inspection.pageCount, 1);
  assert.equal(evidence.pageGeometry.widthPoints, 612);
});
