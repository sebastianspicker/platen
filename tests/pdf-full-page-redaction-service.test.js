import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { PdfFullPageRedactionService } from '../scripts/host/pdf-full-page-redaction-service.mjs';
import {
  FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_PROFILE,
  writeFullPageRedaction, writeFullPageRedactionBatch,
} from '../scripts/host/pdf-full-page-redaction-writer.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';

function streamObject(payload) {
  const bytes = Buffer.from(payload, 'latin1');
  return `<< /Length ${bytes.length + 1} >>\nstream\n${payload}\nendstream`;
}

function fixture() {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, streamObject('BT /F1 12 Tf 10 80 Td (secret) Tj ET')],
    [6, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 8 0 R >> >> /Contents 7 0 R >>'],
    [7, streamObject('BT /F1 12 Tf 10 80 Td (survivor) Tj ET')],
    [8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const size = 9; const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let index = 1; index < size; index += 1) chunks.push(`${String(offsets.get(index)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function image(black) {
  const pixels = Buffer.alloc(16);
  for (let index = 0; index < 4; index += 1) { pixels[index * 4] = black ? 0 : 255; pixels[index * 4 + 1] = black ? 0 : 255; pixels[index * 4 + 2] = black ? 0 : 255; pixels[index * 4 + 3] = 255; }
  return encodeRgbaPng({ width: 2, height: 2, pixels });
}

async function setup(context, {
  abortAfterPromotion = false, batch = false, cleanupFailure = false,
  pageBoxDrift = false, attachmentDrift = false, urlDrift = false,
  replacementArtifact = false, core,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'full-page-redaction-service-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = fixture(); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(source).digest('hex'); const controller = new AbortController(); const observed = { deleted: [], promoted: 0, workspaces: [] };
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => createHash('sha256').update(await readFile(sourcePath)).digest('hex') === sourceSha256,
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces.push(path); return path; },
    cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); if (cleanupFailure) throw new Error('cleanup failed'); },
    promotePdfArtifact: async (_id, _path, promotion) => { observed.promoted += 1; if (abortAfterPromotion) controller.abort(new Error('cancelled')); return { id: '22222222-2222-4222-8222-222222222222', sha256: replacementArtifact ? '0'.repeat(64) : promotion.expectedSha256, operation: promotion.operation }; },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const poppler = { execute: async (operation, parameters) => {
    const output = String(parameters.input).endsWith('/output.pdf');
    if (operation === 'inspect') return { stdout: 'Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\n', stderr: '' };
    if (operation === 'inspectMetadata' || operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') {
      const secondWidth = output && pageBoxDrift ? 101 : 100;
      return { stdout: `Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\nPage 2 size: ${secondWidth} x 100 pts\nPage 2 rot: 0\nPage 2 MediaBox: 0 0 ${secondWidth} 100\nPage 2 CropBox: 0 0 100 100\n`, stderr: '' };
    }
    if (operation === 'listAttachments') return { stdout: output && attachmentDrift ? '1: retained.txt\n' : '', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: output && urlDrift ? 'Page URL\n1 URI https://example.test/\n' : '', stderr: '' };
    if (operation === 'extractText') return { stdout: output ? (batch ? '\f' : '\fsurvivor') : 'secret\fsurvivor', stderr: '' };
    if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, image(output && (batch ? [1, 2].includes(parameters.page) : parameters.page === 1) ? true : false)); return { stdout: '', stderr: '' }; }
    throw new Error(`Unexpected Poppler operation: ${operation}`);
  } };
  return { service: new PdfFullPageRedactionService({ store, poppler, core }), sourceSha256, controller, observed };
}

const request = (sourceSha256) => ({ profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256, page: 1 });

test('full-page redaction service publishes source-bound closed output with independent evidence', async (context) => {
  const setupValue = await setup(context); const result = await setupValue.service.update(documentId, request(setupValue.sourceSha256), { sourceSha256: setupValue.sourceSha256 });
  assert.equal(result.kind, 'pdf-full-page-redaction'); assert.equal(result.redaction.fullPage, true); assert.equal(result.evidence.closedCompactRewrite, true); assert.equal(result.evidence.targetContentResourcesRemoved, true); assert.equal(result.evidence.targetTextEmpty, true); assert.equal(result.evidence.targetRenderBlack, true); assert.equal(result.evidence.nonTargetTextRenderMatched, true); assert.equal(result.limitations.some((entry) => /region redaction|whole-document sanitization/i.test(entry)), true); assert.equal(setupValue.observed.promoted, 1);
});

test('full-page redaction service revokes promotion after cancellation', async (context) => {
  const setupValue = await setup(context, { abortAfterPromotion: true });
  await assert.rejects(setupValue.service.update(documentId, request(setupValue.sourceSha256), { sourceSha256: setupValue.sourceSha256, signal: setupValue.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(setupValue.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});

test('full-page redaction service publishes one atomic multi-page artifact', async (context) => {
  const setupValue = await setup(context, { batch: true }); const result = await setupValue.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: setupValue.sourceSha256, pages: [1, 2] }, { sourceSha256: setupValue.sourceSha256 });
  assert.equal(result.kind, 'pdf-full-page-redaction-batch'); assert.deepEqual(result.pages, [1, 2]); assert.equal(result.evidence.targetPagesBlack, true); assert.equal(setupValue.observed.promoted, 1);
});

test('full-page redaction batch independently rejects proof tampering and source-buffer overlap', async (context) => {
  const tamperedCore = {
    writeFullPageRedaction,
    writeFullPageRedactionBatch: (bytes, requestValue) => {
      const result = writeFullPageRedactionBatch(bytes, requestValue);
      return { bytes: result.bytes, proof: { ...result.proof, outputSha256: '0'.repeat(64) } };
    },
  };
  const tampered = await setup(context, { batch: true, core: tamperedCore });
  await assert.rejects(tampered.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: tampered.sourceSha256, pages: [1, 2] }, { sourceSha256: tampered.sourceSha256 }), { code: 'FULL_PAGE_REDACTION_OUTPUT_INVALID' });

  const overlapCore = {
    writeFullPageRedaction,
    writeFullPageRedactionBatch: (bytes, requestValue) => {
      const result = writeFullPageRedactionBatch(bytes, requestValue);
      return { bytes, proof: result.proof };
    },
  };
  const overlapValue = await setup(context, { batch: true, core: overlapCore });
  await assert.rejects(overlapValue.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: overlapValue.sourceSha256, pages: [1, 2] }, { sourceSha256: overlapValue.sourceSha256 }), { code: 'FULL_PAGE_REDACTION_OUTPUT_INVALID' });
});

test('full-page redaction batch rejects staged output tampering and promotion replacement', async (context) => {
  const tamperingCore = {
    writeFullPageRedaction,
    writeFullPageRedactionBatch: (bytes, requestValue) => {
      const result = writeFullPageRedactionBatch(bytes, requestValue);
      queueMicrotask(() => result.bytes.fill(0));
      return result;
    },
  };
  const tampered = await setup(context, { batch: true, core: tamperingCore });
  await assert.rejects(tampered.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: tampered.sourceSha256, pages: [1, 2] }, { sourceSha256: tampered.sourceSha256 }), { code: 'FULL_PAGE_REDACTION_OUTPUT_INVALID' });

  const replaced = await setup(context, { batch: true, replacementArtifact: true });
  await assert.rejects(replaced.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: replaced.sourceSha256, pages: [1, 2] }, { sourceSha256: replaced.sourceSha256 }), { code: 'FULL_PAGE_REDACTION_OUTPUT_INVALID' });
  assert.deepEqual(replaced.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});

test('full-page redaction batch revokes promotion after cancellation', async (context) => {
  const setupValue = await setup(context, { batch: true, abortAfterPromotion: true });
  await assert.rejects(setupValue.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: setupValue.sourceSha256, pages: [1, 2] }, { sourceSha256: setupValue.sourceSha256, signal: setupValue.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(setupValue.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});

test('full-page redaction batch reports cleanup failure', async (context) => {
  const setupValue = await setup(context, { batch: true, cleanupFailure: true });
  await assert.rejects(setupValue.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: setupValue.sourceSha256, pages: [1, 2] }, { sourceSha256: setupValue.sourceSha256 }), { code: 'FULL_PAGE_REDACTION_CLEANUP_FAILED' });
});

for (const [name, option] of [['page geometry drift', 'pageBoxDrift'], ['attachment drift', 'attachmentDrift'], ['URL drift', 'urlDrift']]) {
  test(`full-page redaction batch rejects ${name}`, async (context) => {
    const setupValue = await setup(context, { batch: true, [option]: true });
    await assert.rejects(setupValue.service.updateBatch(documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: setupValue.sourceSha256, pages: [1, 2] }, { sourceSha256: setupValue.sourceSha256 }), { code: 'FULL_PAGE_REDACTION_OUTPUT_INVALID' });
  });
}
