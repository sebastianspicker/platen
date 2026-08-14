import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runPostScriptConversionCommand } from '../scripts/cli/commands/postscript-conversion.mjs';
import { preparePostScriptPdfDocumentExport } from '../scripts/host/conversion-postscript-export.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';

const assetId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const sourceBytes = Buffer.from('%!PS-Adobe-3.0\n/Helvetica findfont 18 scalefont setfont\n72 720 moveto\n(Hello from PostScript) show\nshowpage\n', 'latin1');
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(80, 0x4f)]);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    value: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
}

function fixture({ operation = {}, evidence = {}, writer = null } = {}) {
  const state = { deleted: [], emitted: 0 };
  const asset = Object.freeze({
    id: assetId, displayName: 'source.ps', mediaType: 'application/postscript', kind: 'postscript', extension: '.ps',
    size: sourceBytes.length, sha256: sourceSha256,
  });
  const provenance = createOperationProvenance({
    type: 'postscript-to-pdf', inputs: [{ assetId, sha256: sourceSha256, role: 'source' }],
    parameters: { sourceFormat: 'ps', sourceKind: 'postscript' }, expected: { minimumPageCount: 1 },
    validation: { passed: true, validators: ['source-sha256', 'ghostscript-exit-zero', 'pdfinfo-page-count'], pageCount: 1, ...operation.validation },
  });
  const document = Object.freeze({ id: documentId, origin: 'derived', mediaType: 'application/pdf', size: pdfBytes.length, sha256: pdfSha256, operation: provenance });
  const baseEvidence = {
    bytes: pdfBytes,
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' },
    pages: [{ page: 1, widthPoints: 612, heightPoints: 792 }],
    textPages: [{ page: 1, text: 'Hello' }],
  };
  const output = capture();
  return {
    state, output,
    command: { command: 'convert-postscript-local', input: 'source.ps', output: 'output.pdf' },
    application: {
      inputs: {
        async createInput(request) {
          const chunks = []; for await (const chunk of request.stream) chunks.push(Buffer.from(chunk));
          assert.deepEqual(Buffer.concat(chunks), sourceBytes);
          assert.equal(request.mediaType, asset.mediaType);
          return asset;
        },
        async verifyInput(id) { assert.equal(id, assetId); },
      },
      conversion: {
        async convertInput(id) { assert.equal(id, assetId); return document; },
        async preparePostScriptPdfExport(id) { assert.equal(id, documentId); return { ...baseEvidence, ...evidence }; },
      },
      store: { async deleteDocument(id) { state.deleted.push(id); } },
    },
    runtime: {
      cancelled() {},
      canonicalOutputTarget: async () => {},
      readLocalInputBytes: async () => ({ bytes: sourceBytes, displayName: 'source.ps' }),
      writeExclusiveVerified: writer ?? (async (_path, bytes, _signal, finalize) => finalize(Object.freeze({ size: bytes.length, sha256: pdfSha256 }))),
      emit: async (_stream, value) => { state.emitted += 1; await new Promise((resolve) => output.stream.write(`${JSON.stringify(value)}\n`, resolve)); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    },
  };
}

test('convert-postscript-local validates evidence and emits a privacy-minimal receipt', async () => {
  const value = fixture();
  await runPostScriptConversionCommand(value.application, value.command, value.output.stream, undefined, value.runtime);
  const receipt = value.output.value();
  assert.equal(receipt.kind, 'postscript-to-pdf');
  assert.equal(receipt.source.format, 'ps');
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, pdfSha256);
  assert.equal(receipt.text.aggregateSha256, createHash('sha256').update('Hello').digest('hex'));
  assert.equal(receipt.passiveIndicators.form, 'none');
  assert.equal(Object.hasOwn(receipt, 'documentId'), false);
});

test('convert-postscript-local rejects forged provenance or evidence and revokes only validated documents', async () => {
  const forged = fixture({ operation: { validation: { validators: ['source-sha256', 'forged', 'pdfinfo-page-count'] } } });
  await assert.rejects(runPostScriptConversionCommand(forged.application, forged.command, forged.output.stream, undefined, forged.runtime), { code: 'CLI_INVALID_POSTSCRIPT_CONVERSION' });
  assert.deepEqual(forged.state.deleted, []);
  const invalidEvidence = fixture({ evidence: { pages: [{ page: 1, widthPoints: Infinity, heightPoints: 792 }] } });
  await assert.rejects(runPostScriptConversionCommand(invalidEvidence.application, invalidEvidence.command, invalidEvidence.output.stream, undefined, invalidEvidence.runtime), { code: 'CLI_INVALID_POSTSCRIPT_CONVERSION' });
  assert.deepEqual(invalidEvidence.state.deleted, [documentId]);
});

test('convert-postscript-local treats receipt finalization as the cancellation boundary', async () => {
  const value = fixture({ writer: async (_path, _bytes, _signal, finalize) => {
    await finalize(Object.freeze({ size: pdfBytes.length, sha256: pdfSha256 }));
    throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
  } });
  await assert.rejects(runPostScriptConversionCommand(value.application, value.command, value.output.stream, undefined, value.runtime), { code: 'JOB_CANCELLED' });
  assert.deepEqual(value.state.deleted, [documentId]);
});

test('installed Ghostscript and Poppler execute and publish the PostScript command end to end', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/gs', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Ghostscript and Poppler tools are unavailable.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-cli-postscript-live-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = join(root, 'source.ps');
  const outputPath = join(root, 'output.pdf');
  const output = capture();
  const { InputAssetStore } = await import('../scripts/host/input-asset-store.mjs');
  const { DocumentStore } = await import('../scripts/host/document-store.mjs');
  const { ConversionService } = await import('../scripts/host/conversion-service.mjs');
  const { EngineRegistry } = await import('../scripts/host/engine-registry.mjs');
  const { createProcessLimiter } = await import('../scripts/host/process-runner.mjs');
  const { GhostscriptAdapter } = await import('../scripts/host/adapters/ghostscript.mjs');
  const { LibreOfficeAdapter } = await import('../scripts/host/adapters/libreoffice.mjs');
  const { ImageMagickAdapter } = await import('../scripts/host/adapters/imagemagick.mjs');
  const { PopplerAdapter } = await import('../scripts/host/adapters/poppler.mjs');
  await (await import('node:fs/promises')).writeFile(inputPath, sourceBytes, { mode: 0o600 });
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => documents.dispose());
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const poppler = new PopplerAdapter({ registry, runner });
  const service = new ConversionService({ documents, inputs, poppler, ghostscript: new GhostscriptAdapter({ registry, runner }), libreOffice: new LibreOfficeAdapter({ registry, runner }), imageMagick: new ImageMagickAdapter({ registry, runner }) });
  const application = {
    inputs,
    store: documents,
    conversion: {
      convertInput: service.convertInput.bind(service),
      preparePostScriptPdfExport: (id, options) => preparePostScriptPdfDocumentExport({ documents, poppler, documentId: id, externalSignal: options?.signal }),
    },
  };
  const runtime = await import('../scripts/cli/runtime.mjs');
  await runPostScriptConversionCommand(application, { command: 'convert-postscript-local', input: inputPath, output: outputPath }, output.stream, undefined, runtime);
  const receipt = output.value();
  const published = await readFile(outputPath);
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, createHash('sha256').update(published).digest('hex'));
  assert.equal(receipt.pdf.pages, 1);
  assert.equal(receipt.text.nonEmptyPages, 1);
  assert.equal(receipt.passiveIndicators.javascript, 'no');
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});
