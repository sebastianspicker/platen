import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';
import { runOfficeConversionCommand } from '../scripts/cli/commands/office-conversion.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { writeStoredZip } from '../scripts/host/pdf-ooxml-export-zip.mjs';

const assetId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const sourceBytes = writeStoredZip([
  ['mimetype', 'application/vnd.oasis.opendocument.text'],
  ['content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><text:p>Hello from installed LibreOffice</text:p></office:text></office:body></office:document-content>'],
  ['META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'],
]);
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(80, 0x4f)]);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');

function command() {
  return parseCliArguments(['convert-office-local', 'source.odt', '--output', 'output.pdf']);
}

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
    id: assetId, displayName: 'source.odt',
    mediaType: 'application/vnd.oasis.opendocument.text', kind: 'office', extension: '.odt',
    size: sourceBytes.length, sha256: sourceSha256,
  });
  const provenance = createOperationProvenance({
    type: 'office-to-pdf', inputs: [{ assetId, sha256: sourceSha256, role: 'source' }],
    parameters: { sourceFormat: 'odt', sourceKind: 'office', conversionMode: 'libreoffice' }, expected: { minimumPageCount: 1 },
    validation: { passed: true, validators: ['source-sha256', 'libreoffice-exit-zero', 'pdfinfo-page-count'], pageCount: 1, ...operation.validation },
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
        async prepareOfficePdfExport(id) { assert.equal(id, documentId); return { ...baseEvidence, ...evidence }; },
      },
      store: { async deleteDocument(id) { state.deleted.push(id); } },
    },
    runtime: {
      cancelled() {},
      canonicalOutputTarget: async () => {},
      readLocalInputBytes: async () => ({ bytes: sourceBytes, displayName: 'source.odt' }),
      writeExclusiveVerified: writer ?? (async (_path, bytes, _signal, finalize) => finalize(Object.freeze({ size: bytes.length, sha256: pdfSha256 }))),
      emit: async (_stream, value) => { state.emitted += 1; await new Promise((resolve) => output.stream.write(`${JSON.stringify(value)}\n`, resolve)); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    },
  };
}

test('convert-office-local parser accepts exactly one ODT and mandatory PDF output', () => {
  assert.deepEqual(command(), { command: 'convert-office-local', input: 'source.odt', output: 'output.pdf' });
  for (const args of [
    ['convert-office-local', 'source.odt'],
    ['convert-office-local', 'source.pdf', '--output', 'output.pdf'],
    ['convert-office-local', 'source.odt', '--output', 'output.txt'],
    ['convert-office-local', 'one.odt', 'two.odt', '--output', 'output.pdf'],
    ['convert-office-local', 'source.odt', '--format', 'pdf', '--output', 'output.pdf'],
  ]) assert.throws(() => parseCliArguments(args), { code: /CLI_INVALID_/u });
});

test('convert-office-local validates evidence and emits a privacy-minimal receipt', async () => {
  const value = fixture();
  await runOfficeConversionCommand(value.application, command(), value.output.stream, undefined, value.runtime);
  const receipt = value.output.value();
  assert.equal(receipt.kind, 'office-to-pdf');
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, pdfSha256);
  assert.equal(receipt.text.aggregateSha256, createHash('sha256').update('Hello').digest('hex'));
  assert.equal(receipt.localOnly, true);
  assert.equal(Object.hasOwn(receipt, 'documentId'), false);
  assert.equal(Object.hasOwn(receipt, 'textPages'), false);
});

test('convert-office-local rejects forged provenance or evidence and revokes only validated documents', async () => {
  const forged = fixture({ operation: { validation: { validators: ['source-sha256', 'fallback', 'pdfinfo-page-count'] } } });
  await assert.rejects(runOfficeConversionCommand(forged.application, command(), forged.output.stream, undefined, forged.runtime), { code: 'CLI_INVALID_OFFICE_CONVERSION' });
  assert.deepEqual(forged.state.deleted, []);
  const invalidEvidence = fixture({ evidence: { pages: [{ page: 1, widthPoints: Infinity, heightPoints: 792 }] } });
  await assert.rejects(runOfficeConversionCommand(invalidEvidence.application, command(), invalidEvidence.output.stream, undefined, invalidEvidence.runtime), { code: 'CLI_INVALID_OFFICE_CONVERSION' });
  assert.deepEqual(invalidEvidence.state.deleted, [documentId]);
});

test('convert-office-local binds cancellation and receipt finalization transactionally', async () => {
  const value = fixture({ writer: async (_path, _bytes, _signal, finalize) => {
    await finalize(Object.freeze({ size: pdfBytes.length, sha256: pdfSha256 }));
    throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
  } });
  await assert.rejects(runOfficeConversionCommand(value.application, command(), value.output.stream, undefined, value.runtime), { code: 'JOB_CANCELLED' });
  assert.deepEqual(value.state.deleted, [documentId]);
});

test('installed LibreOffice and Poppler execute the shipped ODT command end to end', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/soffice', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('The fixed LibreOffice and Poppler tools are unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-office-live-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'source.odt');
  const outputPath = join(directory, 'output.pdf');
  await writeFile(inputPath, sourceBytes, { mode: 0o600 });
  const output = capture();
  await runCli(['convert-office-local', inputPath, '--output', outputPath], { stdout: output.stream });
  const receipt = output.value();
  const published = await readFile(outputPath);
  assert.equal(receipt.kind, 'office-to-pdf');
  assert.equal(receipt.source.format, 'odt');
  assert.equal(receipt.source.sha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(receipt.pdf.sha256, createHash('sha256').update(published).digest('hex'));
  assert.equal(receipt.pdf.pages, 1);
  assert.equal(receipt.text.nonEmptyPages, 1);
  assert.equal(receipt.passiveIndicators.encrypted, 'no');
  assert.equal(receipt.passiveIndicators.javascript, 'no');
  assert.equal(receipt.passiveIndicators.form, 'none');
  const metadata = await stat(outputPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['output.pdf', 'source.odt']);
});
