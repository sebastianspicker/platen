import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runPrintToPdfCommand } from '../scripts/cli/commands/print-to-pdf.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { runCli } from '../scripts/platen-cli.mjs';

const source = Buffer.from('fixture\n');
const bytes = Buffer.from('%PDF-1.7\nfixture');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const pdfSha256 = createHash('sha256').update(bytes).digest('hex');
const asset = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111', displayName: 'fixture.txt',
  mediaType: 'text/plain', kind: 'text', extension: '.txt', size: source.length, sha256: sourceSha256,
});
const document = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222', origin: 'derived', mediaType: 'application/pdf',
  size: bytes.length, sha256: pdfSha256,
  operation: createOperationProvenance({
    type: 'cups-text-to-pdf', inputs: [{ assetId: asset.id, sha256: sourceSha256, role: 'source' }],
    parameters: { sourceFormat: 'txt', sourceMediaType: 'text/plain', filter: 'cgtexttopdf' },
    expected: { minimumPageCount: 1, maximumPageCount: 64 },
    validation: { passed: true, validators: ['source-sha256', 'cupsfilter-cgtexttopdf', 'pdfinfo-page-count', 'pdfinfo-passive'], pageCount: 1 },
  }),
});
function evidence() {
  return { bytes, inspection: { pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' }, pages: [{ page: 1, widthPoints: 612, heightPoints: 792 }], textPages: [{ page: 1, text: 'fixture' }] };
}
function fixture(chunks, options = {}) {
  const localSource = options.source ?? source;
  const localAsset = options.asset ?? asset;
  const localDocument = options.document ?? document;
  const localEvidence = options.evidence ?? evidence();
  const receipt = options.receipt ?? Object.freeze({ size: bytes.length, sha256: pdfSha256 });
  return {
    cancelled(signal) { if (signal?.aborted) { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; } },
    fail(code, message) { const error = new Error(message); error.code = code; throw error; },
    async canonicalOutputTarget() {},
    async readLocalInputBytes() { return { bytes: localSource, displayName: 'fixture.txt' }; },
    async writeExclusiveVerified(_path, payload, _signal, done) {
      assert.equal(payload.equals(bytes), true);
      await done(receipt);
    },
    async emit(stream, value) { stream.write(JSON.stringify(value)); },
    application: {
      inputs: { async createInput() { return localAsset; }, async verifyInput() {} },
      cupsPrintToPdf: {
        async convertInput() { return localDocument; },
        async prepareRetainedArtifactExport() { return localEvidence; },
      },
      store: { async deleteDocument() {} },
    },
    output: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
  };
}

test('print-to-pdf-local publishes a privacy-minimal fixed-profile receipt', async () => {
  const chunks = [];
  const value = fixture(chunks);
  await runPrintToPdfCommand(value.application, { command: 'print-to-pdf-local', input: 'fixture.txt', output: 'fixture.pdf' }, value.output, undefined, value);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).kind, 'cups-text-to-pdf');
});

test('print-to-pdf-local rejects malformed local text and forged input/document/evidence', async () => {
  for (const localSource of [Buffer.from([0xc3]), Buffer.from('x\0')]) {
    const value = fixture([], { source: localSource });
    await assert.rejects(runPrintToPdfCommand(value.application, { input: 'fixture.txt', output: 'fixture.pdf' }, value.output, undefined, value), { code: 'CLI_INVALID_TEXT_INPUT' });
  }
  const forgedAsset = fixture([], { asset: { ...asset, sha256: '0'.repeat(64) } });
  await assert.rejects(runPrintToPdfCommand(forgedAsset.application, { input: 'fixture.txt', output: 'fixture.pdf' }, forgedAsset.output, undefined, forgedAsset), { code: 'CLI_INVALID_INPUT_RECORD' });
  const forgedDocument = fixture([], { document: { ...document, sha256: '0'.repeat(64) } });
  await assert.rejects(runPrintToPdfCommand(forgedDocument.application, { input: 'fixture.txt', output: 'fixture.pdf' }, forgedDocument.output, undefined, forgedDocument), { code: 'CLI_INVALID_CUPS_PRINT_TO_PDF' });
  const forgedEvidence = fixture([], { evidence: { ...evidence(), bytes: Buffer.from('%PDF-1.7\nforged') } });
  await assert.rejects(runPrintToPdfCommand(forgedEvidence.application, { input: 'fixture.txt', output: 'fixture.pdf' }, forgedEvidence.output, undefined, forgedEvidence), { code: 'CLI_INVALID_CUPS_PRINT_TO_PDF' });
  const nonTextEvidence = fixture([], { evidence: { ...evidence(), textPages: [{ page: 1, text: {} }] } });
  await assert.rejects(runPrintToPdfCommand(nonTextEvidence.application, { input: 'fixture.txt', output: 'fixture.pdf' }, nonTextEvidence.output, undefined, nonTextEvidence), { code: 'CLI_INVALID_CUPS_PRINT_TO_PDF' });
});

test('print-to-pdf-local revokes its document on receipt/cancellation failures', async () => {
  const deleted = [];
  const badReceipt = fixture([], { receipt: Object.freeze({ size: 1, sha256: pdfSha256 }) });
  badReceipt.application.store.deleteDocument = async (id) => { deleted.push(id); };
  await assert.rejects(runPrintToPdfCommand(badReceipt.application, { input: 'fixture.txt', output: 'fixture.pdf' }, badReceipt.output, undefined, badReceipt), { code: 'CLI_INVALID_CUPS_PRINT_TO_PDF' });
  assert.deepEqual(deleted, [document.id]);
  const controller = new AbortController();
  const cancelled = fixture([]);
  cancelled.application.cupsPrintToPdf.convertInput = async () => { controller.abort(); return document; };
  await assert.rejects(runPrintToPdfCommand(cancelled.application, { input: 'fixture.txt', output: 'fixture.pdf' }, cancelled.output, controller.signal, cancelled), { code: 'JOB_CANCELLED' });
  const cleanup = fixture([], { evidence: { ...evidence(), bytes: Buffer.from('forged') } });
  cleanup.application.store.deleteDocument = async () => { throw new Error('cleanup failed'); };
  await assert.rejects(runPrintToPdfCommand(cleanup.application, { input: 'fixture.txt', output: 'fixture.pdf' }, cleanup.output, undefined, cleanup), { code: 'CLI_CONVERSION_CLEANUP_FAILED' });
});

test('installed CUPS and Poppler execute the shipped print-to-pdf command end to end', async (context) => {
  try {
    await Promise.all(['/usr/sbin/cupsfilter', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext']
      .map((path) => access(path)));
  } catch {
    context.skip('The fixed CUPS and Poppler tools are unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-cups-live-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'source.txt');
  const outputPath = join(directory, 'output.pdf');
  const inputBytes = Buffer.from('Hello from the shipped CUPS command.\n', 'utf8');
  await writeFile(inputPath, inputBytes, { mode: 0o600 });
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  await runCli(['print-to-pdf-local', inputPath, '--output', outputPath], { stdout: output });
  const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const published = await readFile(outputPath);
  assert.equal(receipt.kind, 'cups-text-to-pdf');
  assert.equal(receipt.source.sha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(receipt.pdf.sha256, createHash('sha256').update(published).digest('hex'));
  assert.equal(receipt.pdf.pages, 1);
  assert.equal(receipt.text.nonEmptyPages, 1);
  assert.deepEqual(receipt.passiveIndicators, { encrypted: 'no', javascript: 'no', form: 'none' });
  const metadata = await stat(outputPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['output.pdf', 'source.txt']);
});
