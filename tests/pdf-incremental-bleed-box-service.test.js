import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfIncrementalBleedBoxService } from '../scripts/host/pdf-incremental-bleed-box-service.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { Readable } from 'node:stream';

const sourceBytes = Buffer.from(`%PDF-1.4\n${'source '.repeat(20)}\nstartxref\n10\n%%EOF\n`);
const outputBytes = Buffer.concat([sourceBytes, Buffer.from(`\n${'append '.repeat(20)}\nstartxref\n200\n%%EOF\n`)]);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const request = Object.freeze({ profile: 'local-classic-incremental-bleed-box-v1', page: 1, rect: Object.freeze({ x: 10, y: 10, width: 80, height: 80 }) });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(32).fill(0)]);

function proof() {
  return Object.freeze({
    profile: request.profile, sourceBytes: sourceBytes.length, outputBytes: outputBytes.length,
    appendedBytes: outputBytes.length - sourceBytes.length, sourcePrefixPreserved: true,
    onlyTargetChanged: true, revisionCount: 2, sourceRevisionCount: 1,
    previousXrefOffset: 10, appendedXrefOffset: sourceBytes.length + 10, page: 1,
    pageObjectNumber: 3, pageGeneration: 0, pageReference: '3 0 R', rect: request.rect,
    effectiveSize: 6, rootPreserved: true, infoPreserved: true, idPolicy: 'absent',
  });
}

function info({ changedMetadata = false } = {}) {
  const title = changedMetadata ? 'Title: unexpected output title\n' : 'Title: preserved title\n';
  return `${title}Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n`;
}
function boxes({ changed = false } = {}) {
  const bleed = changed ? '10 10 90 90' : '0 0 100 100';
  return `Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\nPage 1 BleedBox: ${bleed}\nPage 1 TrimBox: 20 20 80 80\nPage 1 ArtBox: 20 20 80 80\n`;
}

async function fixture({
  unsupported = false,
  envelopeMismatch = false,
  badBoxes = false,
  renderMismatch = false,
  swapSource = false,
  promotionFailure = false,
  secondWorkspaceFailure = false,
  cleanupFailure = false,
  overlappingOutput = false,
  abortAfterPromotion = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'incremental-bleed-box-'));
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const calls = {
    write: 0, inspect: 0, verify: 0, workspace: 0, deleted: null, clean: [],
  };
  const store = {
    getDocument: () => ({ id: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256, size: sourceBytes.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => { calls.verify += 1; assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256); },
    createJobWorkspace: async () => {
      calls.workspace += 1;
      if (secondWorkspaceFailure && calls.workspace === 2) throw new Error('workspace refused');
      const path = await mkdtemp(join(root, 'job-'));
      await chmod(path, 0o700);
      return path;
    },
    cleanupJob: cleanupFailure
      ? () => { throw new Error('cleanup refused'); }
      : async (path) => {
        calls.clean.push(await readdir(path));
        await rm(path, { recursive: true, force: true });
      },
    promotePdfArtifact: async (_id, path, options) => {
      if (promotionFailure) throw new Error('promotion refused');
      if (swapSource) await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('swap')]));
      const bytes = await readFile(path); assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256);
      abortAfterPromotion?.abort(new Error('cancel after promotion'));
      return { id: 'artifact', sha256: options.expectedSha256, displayName: 'bleed.pdf', operation: options.operation };
    },
    deleteArtifact: async (id) => { calls.deleted = id; },
  };
  const poppler = { async execute(operation, parameters) {
    const output = parameters.input.endsWith('output.pdf');
    if (operation === 'inspect') return { stdout: unsupported ? 'Pages: 1\nEncrypted: yes\nForm: none\nJavaScript: no\n' : info({ changedMetadata: output && envelopeMismatch }), stderr: '' };
    if (operation === 'inspectMetadata') return { stdout: '', stderr: '' };
    if (operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') {
      if (output && swapSource) await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('swap')]));
      return { stdout: boxes({ changed: output && !badBoxes }), stderr: '' };
    }
    if (operation === 'extractText') return { stdout: 'fixture\f', stderr: '' };
    if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, output && renderMismatch ? Buffer.from([...png, 1]) : png); return { stdout: '', stderr: '' }; }
    assert.fail(`unexpected Poppler operation ${operation}`);
  } };
  const core = {
    normalizeIncrementalBleedBox: (value) => {
      if (value !== request) throw Object.assign(new Error('invalid'), { code: 'INVALID_INCREMENTAL_BLEED_BOX' });
      return request;
    },
    writeIncrementalPdfBleedBox: (input) => {
      calls.write += 1;
      assert.deepEqual(input, sourceBytes);
      return { bytes: overlappingOutput ? input.subarray(0) : Buffer.from(outputBytes), proof: proof() };
    },
    inspectIncrementalPdfBleedBox: (input, output) => { calls.inspect += 1; assert.deepEqual(input, sourceBytes); assert.deepEqual(output, outputBytes); return proof(); },
  };
  return { root, calls, service: new PdfIncrementalBleedBoxService({ store, poppler, core }) };
}

test('incremental BleedBox service independently validates and promotes a source-bound artifact', async (context) => {
  const setup = await fixture(); context.after(() => rm(setup.root, { recursive: true, force: true }));
  const result = await setup.service.update('11111111-1111-4111-8111-111111111111', request, { sourceSha256 });
  assert.equal(result.kind, 'pdf-incremental-bleed-box'); assert.equal(result.artifact.sha256, createHash('sha256').update(outputBytes).digest('hex'));
  assert.deepEqual(result.pageBox, request); assert.equal(result.evidence.samePageObjectRevision, true);
  assert.equal(setup.calls.write, 1); assert.equal(setup.calls.inspect, 1); assert.equal(setup.calls.verify, 2);
  assert.equal(setup.calls.clean.length, 2); assert.equal(setup.calls.clean.flat().some((name) => name.endsWith('.png')), false);
});

test('incremental BleedBox service fails closed before write for digest and unsupported envelope', async (context) => {
  const stale = await fixture(); context.after(() => rm(stale.root, { recursive: true, force: true }));
  await assert.rejects(stale.service.update('11111111-1111-4111-8111-111111111111', request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.equal(stale.calls.write, 0);
  const unsupported = await fixture({ unsupported: true }); context.after(() => rm(unsupported.root, { recursive: true, force: true }));
  await assert.rejects(unsupported.service.update('11111111-1111-4111-8111-111111111111', request, { sourceSha256 }), { code: 'INCREMENTAL_BLEED_BOX_SOURCE_UNSUPPORTED' });
  assert.equal(unsupported.calls.write, 0); assert.equal(unsupported.calls.clean.length, 2);
});

test('incremental BleedBox service rejects envelope, geometry, and render disagreement before promotion', async (context) => {
  for (const options of [
    { envelopeMismatch: true },
    { badBoxes: true },
    { renderMismatch: true },
  ]) {
    const setup = await fixture(options); context.after(() => rm(setup.root, { recursive: true, force: true }));
    await assert.rejects(setup.service.update('11111111-1111-4111-8111-111111111111', request, { sourceSha256 }), { code: 'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID' });
    assert.equal(setup.calls.deleted, null); assert.equal(setup.calls.clean.length, 2);
  }
});

test('incremental BleedBox service rechecks source and cleans workspaces after promotion failure', async (context) => {
  const setup = await fixture({ promotionFailure: true }); context.after(() => rm(setup.root, { recursive: true, force: true }));
  await assert.rejects(setup.service.update('11111111-1111-4111-8111-111111111111', request, { sourceSha256 }), { code: 'INCREMENTAL_BLEED_BOX_FAILED' });
  assert.equal(setup.calls.clean.length, 2);
});

test('incremental BleedBox service detects a source swap after staging and before promotion', async (context) => {
  const setup = await fixture({ swapSource: true }); context.after(() => rm(setup.root, { recursive: true, force: true }));
  await assert.rejects(setup.service.update('11111111-1111-4111-8111-111111111111', request, { sourceSha256 }), { code: 'INCREMENTAL_BLEED_BOX_FAILED' });
  assert.equal(setup.calls.clean.length, 2);
});

test('incremental BleedBox service cleans a first workspace when the second allocation fails', async (context) => {
  const setup = await fixture({ secondWorkspaceFailure: true });
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  await assert.rejects(setup.service.update(
    '11111111-1111-4111-8111-111111111111', request, { sourceSha256 },
  ), { code: 'INCREMENTAL_BLEED_BOX_FAILED' });
  assert.equal(setup.calls.clean.length, 1);
  assert.equal(setup.calls.workspace, 2);
});
test('incremental BleedBox service rejects core buffers that overlap private source bytes', async (context) => {
  const setup = await fixture({ overlappingOutput: true });
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  await assert.rejects(setup.service.update(
    '11111111-1111-4111-8111-111111111111', request, { sourceSha256 },
  ), { code: 'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID' });
  assert.deepEqual(await readFile(join(setup.root, 'source.pdf')), sourceBytes);
  assert.equal(setup.calls.inspect, 0);
  assert.equal(setup.calls.clean.length, 2);
});
test('incremental BleedBox service deletes promotion when cleanup fails or cancellation wins', async (context) => {
  const cleanup = await fixture({ cleanupFailure: true });
  context.after(() => rm(cleanup.root, { recursive: true, force: true }));
  await assert.rejects(cleanup.service.update(
    '11111111-1111-4111-8111-111111111111', request, { sourceSha256 },
  ), { code: 'INCREMENTAL_BLEED_BOX_CLEANUP_FAILED' });
  assert.equal(cleanup.calls.deleted, 'artifact');
  const controller = new AbortController();
  const cancelled = await fixture({ abortAfterPromotion: controller });
  context.after(() => rm(cancelled.root, { recursive: true, force: true }));
  await assert.rejects(cancelled.service.update(
    '11111111-1111-4111-8111-111111111111', request,
    { sourceSha256, signal: controller.signal },
  ), { code: 'JOB_CANCELLED' });
  assert.equal(cancelled.calls.deleted, 'artifact');
  assert.equal(cancelled.calls.clean.length, 2);
});

function classicPdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /BleedBox [0 0 100 100] /TrimBox [10 10 90 90] /ArtBox [10 10 90 90] /Resources <<>> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  const chunks = ['%PDF-1.4\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 5\n0000000000 65535 f \n');
  offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

test('installed Poppler service publishes a real classic incremental BleedBox artifact', { timeout: 30_000 }, async (context) => {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 }); const registry = new EngineRegistry({ runner });
  const required = ['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfdetach', 'pdfsig'];
  if ((await Promise.allSettled(required.map((name) => registry.probe(name)))).some(({ status }) => status === 'rejected')) return context.skip('Required Poppler tools are unavailable.');
  const root = await mkdtemp(join(tmpdir(), 'incremental-bleed-box-poppler-')); const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const document = await store.createDocument({ stream: Readable.from([classicPdf()]), displayName: 'classic.pdf', mediaType: 'application/pdf' });
  const service = new PdfIncrementalBleedBoxService({ store, poppler: new PopplerAdapter({ registry, runner }) });
  const result = await service.update(document.id, request, { sourceSha256: document.sha256 });
  assert.equal(result.artifact.sha256 === document.sha256, false); assert.equal(result.evidence.pageValidationRendersMatched, true);
  assert.equal(await store.verifySource(document.id), true);
});
