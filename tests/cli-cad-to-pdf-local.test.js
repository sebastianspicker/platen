import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCadToPdfCommand } from '../scripts/cli/commands/cad-to-pdf.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { runCli } from '../scripts/platen-cli.mjs';

const assetId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const dxf = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n');
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const sourceSha256 = createHash('sha256').update(dxf).digest('hex');
const pdfSha256 = createHash('sha256').update(pdf).digest('hex');

function capture() {
  const chunks = [];
  return { stream: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
    value: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

function fixture({ forged = false, writer, evidence: suppliedEvidence } = {}) {
  const state = { deleted: [] }; const output = capture();
  const asset = Object.freeze({ id: assetId, displayName: 'drawing.dxf', mediaType: 'image/vnd.dxf', kind: 'cad', extension: '.dxf', size: dxf.length, sha256: sourceSha256 });
  const operation = createOperationProvenance({ type: 'cad-to-pdf', inputs: [{ assetId, sha256: sourceSha256, role: 'source' }],
    parameters: { sourceFormat: 'dxf', sourceKind: 'cad', conversionMode: forged ? 'forged' : 'platen-dxf-line-subset', entityCount: 1, widthPoints: 612, heightPoints: 792 },
    expected: { pageCount: 1 }, validation: { passed: true, validators: ['source-sha256', 'platen-dxf-line-subset-renderer', 'pdfinfo-page-count'], pageCount: 1 } });
  const document = Object.freeze({ id: documentId, origin: 'derived', mediaType: 'application/pdf', size: pdf.length, sha256: pdfSha256, operation });
  const evidence = suppliedEvidence ?? Object.freeze({ bytes: pdf, inspection: Object.freeze({ pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' }),
    pageGeometry: Object.freeze({ page: 1, widthPoints: 612, heightPoints: 792 }), entityCount: 1,
    passiveIndicators: Object.freeze({ encrypted: 'no', javascript: 'no', form: 'none' }) });
  return { state, output, command: { input: 'drawing.dxf', output: 'drawing.pdf' },
    application: { inputs: { async createInput() { return asset; }, async verifyInput() {} },
      conversion: { async convertCadInput() { return document; }, async prepareCadPdfExport() { return evidence; } },
      store: { async deleteDocument(id) { state.deleted.push(id); } } },
    runtime: { cancelled() {}, canonicalOutputTarget: async () => {}, readLocalInputBytes: async () => ({ bytes: dxf, displayName: 'drawing.dxf' }),
      writeExclusiveVerified: writer ?? (async (_target, bytes, _signal, finalize) => finalize(Object.freeze({ size: bytes.length, sha256: pdfSha256 }))),
      emit: async (_stream, value) => new Promise((resolve) => output.stream.write(`${JSON.stringify(value)}\n`, resolve)),
      fail(code, message) { throw Object.assign(new Error(message), { code }); } } };
}

test('CAD CLI publishes a minimal DXF LINE-subset receipt', async () => {
  const value = fixture();
  await runCadToPdfCommand(value.application, value.command, value.output.stream, undefined, value.runtime);
  const receipt = value.output.value();
  assert.equal(receipt.kind, 'cad-to-pdf');
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, pdfSha256);
  assert.equal(receipt.entityCount, 1);
  assert.equal(receipt.passiveIndicators.form, 'none');
  assert.match(receipt.fidelityExclusions.join(' '), /unitless PDF-space values/u);
  assert.equal(Object.hasOwn(receipt, 'documentId'), false);
});

test('CAD CLI rejects forged provenance and revokes a validated document on output failures', async () => {
  const forged = fixture({ forged: true });
  await assert.rejects(runCadToPdfCommand(forged.application, forged.command, forged.output.stream, undefined, forged.runtime), { code: 'CLI_INVALID_CAD_TO_PDF' });
  assert.deepEqual(forged.state.deleted, []);
  const mismatch = fixture({ writer: async (_target, bytes, _signal, finalize) => finalize(Object.freeze({ size: bytes.length, sha256: '0'.repeat(64) })) });
  await assert.rejects(runCadToPdfCommand(mismatch.application, mismatch.command, mismatch.output.stream, undefined, mismatch.runtime), { code: 'CLI_INVALID_CAD_TO_PDF' });
  assert.deepEqual(mismatch.state.deleted, [documentId]);
  const forgedEvidence = Object.freeze({ bytes: pdf, inspection: Object.freeze({ pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' }),
    pageGeometry: Object.freeze({ page: 1, widthPoints: 612, heightPoints: 792 }), entityCount: 1,
    passiveIndicators: Object.freeze({ encrypted: 'no', javascript: 'no', form: 'acroform' }) });
  const evidence = fixture({ evidence: forgedEvidence });
  await assert.rejects(runCadToPdfCommand(evidence.application, evidence.command, evidence.output.stream, undefined, evidence.runtime), { code: 'CLI_INVALID_CAD_TO_PDF' });
  assert.deepEqual(evidence.state.deleted, [documentId]);
});

test('CAD CLI validates extensions and aggregates document-revocation failure', async () => {
  const extension = fixture(); extension.command.output = 'drawing.txt';
  await assert.rejects(runCadToPdfCommand(extension.application, extension.command, extension.output.stream, undefined, extension.runtime), { code: 'CLI_INVALID_CAD_TO_PDF' });
  const cleanup = fixture({ writer: async () => { throw new Error('output exists'); } });
  cleanup.application.store.deleteDocument = async () => { throw new Error('revoke failed'); };
  await assert.rejects(runCadToPdfCommand(cleanup.application, cleanup.command, cleanup.output.stream, undefined, cleanup.runtime), { code: 'CLI_CONVERSION_CLEANUP_FAILED' });
});

test('installed Poppler runs create-cad-pdf-local and preserves an existing output', async (context) => {
  try { await access('/opt/homebrew/bin/pdfinfo'); } catch { context.skip('Fixed Poppler pdfinfo is unavailable.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-cad-live-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'drawing.dxf'); const outputPath = join(directory, 'drawing.pdf');
  await writeFile(input, dxf, { mode: 0o600 });
  const emitted = capture();
  await runCli(['create-cad-pdf-local', input, '--output', outputPath], { stdout: emitted.stream });
  const receipt = emitted.value(); const published = await readFile(outputPath);
  assert.equal(receipt.kind, 'cad-to-pdf');
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, createHash('sha256').update(published).digest('hex'));
  assert.equal(receipt.pdf.pages, 1);
  assert.deepEqual(receipt.pageGeometry, { page: 1, widthPoints: 612, heightPoints: 792 });
  assert.deepEqual(receipt.passiveIndicators, { encrypted: 'no', javascript: 'no', form: 'none' });
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  const before = await readFile(outputPath);
  await assert.rejects(runCli(['create-cad-pdf-local', input, '--output', outputPath], { stdout: capture().stream }), { code: 'CLI_OUTPUT_EXISTS' });
  assert.deepEqual(await readFile(outputPath), before);
});
