import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { GhostscriptAdapter } from '../scripts/host/adapters/ghostscript.mjs';
import { LibreOfficeAdapter } from '../scripts/host/adapters/libreoffice.mjs';
import { ImageMagickAdapter } from '../scripts/host/adapters/imagemagick.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { ConversionService } from '../scripts/host/conversion-service.mjs';
import { preparePostScriptPdfDocumentExport } from '../scripts/host/conversion-postscript-export.mjs';

const postscript = Buffer.from('%!PS-Adobe-3.0\n/Helvetica findfont 18 scalefont setfont\n72 720 moveto\n(POSTSCRIPT EXPORT) show\nshowpage\n', 'latin1');

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-postscript-export-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => documents.dispose());
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const poppler = new PopplerAdapter({ registry, runner });
  const service = new ConversionService({
    documents,
    inputs,
    poppler,
    ghostscript: new GhostscriptAdapter({ registry, runner }),
    libreOffice: new LibreOfficeAdapter({ registry, runner }),
    imageMagick: new ImageMagickAdapter({ registry, runner }),
  });
  service.preparePostScriptPdfExport = (documentId, { signal } = {}) => preparePostScriptPdfDocumentExport({ documents, poppler, documentId, externalSignal: signal });
  return {
    documents,
    inputs,
    poppler,
    service,
  };
}

test('PostScript export retains exact bytes and validates page geometry, text, and passive indicators', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/gs', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Ghostscript and Poppler tools are unavailable.');
    return;
  }
  const { service, documents, inputs } = await fixture(context);
  const source = await inputs.createInput({
    stream: Readable.from([postscript]), displayName: 'source.ps', mediaType: 'application/postscript',
  });
  const document = await service.convertInput(source.id);
  const evidence = await service.preparePostScriptPdfExport(document.id);
  assert.equal(evidence.bytes.length, document.size);
  assert.equal(evidence.inspection.pageCount, 1);
  assert.deepEqual(evidence.pages, [{ page: 1, widthPoints: 612, heightPoints: 792 }]);
  assert.match(evidence.textPages[0].text, /POSTSCRIPT EXPORT/u);
  assert.equal(evidence.inspection.encrypted, 'no');
  assert.equal(evidence.inspection.javascript, 'no');
  assert.equal(evidence.inspection.form, 'none');
  assert.equal(document.operation.validation.validators[1], 'ghostscript-exit-zero');
  assert.equal(await inputs.verifyInput(source.id), true);
  assert.equal(await documents.verifySource(document.id), true);
});

test('PostScript export rejects forged provenance before touching the derived document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platen-postscript-forged-'));
  const documents = await new DocumentStore({ root }).initialize();
  try {
    const document = await documents.createDocument({ stream: Readable.from([Buffer.from('%PDF-1.7\n%%EOF\n')]), displayName: 'forged.pdf', operation: {
      schemaVersion: 1,
      id: '22222222-2222-4222-8222-222222222222',
      type: 'postscript-to-pdf',
      inputs: [{ assetId: '33333333-3333-4333-8333-333333333333', sha256: 'a'.repeat(64), role: 'source' }],
      parameters: { sourceFormat: 'ps', sourceKind: 'postscript' },
      expected: { minimumPageCount: 1 },
      validation: { passed: true, validators: ['source-sha256', 'forged', 'pdfinfo-page-count'], pageCount: 1 },
      completedAt: '2026-08-04T00:00:00.000Z',
    } });
    await assert.rejects(
      () => preparePostScriptPdfDocumentExport({ documents, poppler: {}, documentId: document.id }),
      { code: 'INVALID_POSTSCRIPT_PDF_DOCUMENT', status: 403 },
    );
  } finally {
    await documents.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('PostScript source admission retains exact bounded PS input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platen-postscript-admission-'));
  const inputs = await new InputAssetStore({ root }).initialize();
  try {
    const record = await inputs.createInput({ stream: Readable.from([postscript]), displayName: 'source.eps', mediaType: 'application/postscript' });
    assert.equal(record.kind, 'postscript');
    assert.equal(record.extension, '.eps');
    assert.equal(await inputs.verifyInput(record.id), true);
    await assert.rejects(
      () => inputs.createInput({ stream: Readable.from([Buffer.from('not-postscript')]), displayName: 'source.ps', mediaType: 'application/postscript' }),
      { code: 'INVALID_INPUT_SIGNATURE', status: 415 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
