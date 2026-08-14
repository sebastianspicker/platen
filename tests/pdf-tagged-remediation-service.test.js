import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfTaggedRemediationService } from '../scripts/host/pdf-tagged-remediation-service.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../scripts/host/pdf-tagged-remediation-contract.mjs';
import { inspectTaggedPdfRemediation, writeTaggedPdfRemediation } from '../scripts/host/pdf-tagged-remediation-writer.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>');
  const stream = 'q\nQ\n'; offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1'));
  chunks.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 5\n0000000000 65535 f \n');
  for (const number of [1, 2, 3, 4]) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function request(source) {
  return {
    profile: TAGGED_PDF_REMEDIATION_PROFILE,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    plan: { id: 'document', role: 'Document', children: [{ id: 'paragraph', role: 'P', page: 1, contentIndex: 0 }] },
    language: 'en-US', title: 'Fixture', roleMap: {},
  };
}

async function setup(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tagged-remediation-service-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = fixture(); const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const observed = { workspaces: [], promoted: 0, deleted: [], checks: 0, outputPath: null };
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      observed.checks += 1;
      if (options.swapSource && observed.checks === 2) await writeFile(sourcePath, Buffer.concat([source, Buffer.from('stale')]), { mode: 0o600 });
      const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
      if (digest !== sourceSha256) throw new Error('source changed');
    },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces.push(path); observed.outputPath = join(path, 'output.pdf'); return path; },
    cleanupJob: async (path) => rm(path, { recursive: true, force: true }),
    promotePdfArtifact: async (_id, _path, promotion) => {
      observed.promoted += 1;
      return { id: artifactId, documentId, displayName: 'tagged.pdf', mediaType: 'application/pdf', size: promotion.expectedSha256 ? 1 : 0, sha256: promotion.expectedSha256, operation: promotion.operation, createdAt: new Date().toISOString() };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const core = options.core ?? { normalizeTaggedPdfRemediation: (value) => value, writeTaggedPdfRemediation, inspectTaggedPdfRemediation };
  return { service: new PdfTaggedRemediationService({ store, core }), source, sourceSha256, request: request(source), observed };
}

test('tagged remediation stages an immutable source, independently re-inspects, and promotes a bound artifact', async (context) => {
  const setupValue = await setup(context);
  const result = await setupValue.service.update(documentId, setupValue.request, { sourceSha256: setupValue.sourceSha256 });
  assert.equal(result.kind, 'tagged-pdf-remediation');
  assert.equal(result.proof.sourceSha256, setupValue.sourceSha256);
  assert.equal(result.evidence.independentInspection, true);
  assert.equal(setupValue.observed.promoted, 1);
  assert.equal(setupValue.observed.workspaces.length, 1);
});

test('tagged remediation rejects stale sources and proof disagreement before promotion', async (context) => {
  const stale = await setup(context, { swapSource: true });
  await assert.rejects(stale.service.update(documentId, stale.request, { sourceSha256: stale.sourceSha256 }), { code: 'TAGGED_PDF_REMEDIATION_FAILED' });
  assert.equal(stale.observed.promoted, 0);
  const mismatch = await setup(context, { core: {
    normalizeTaggedPdfRemediation: (value) => value,
    writeTaggedPdfRemediation,
    inspectTaggedPdfRemediation: (...args) => ({ ...inspectTaggedPdfRemediation(...args), outputSha256: 'f'.repeat(64) }),
  } });
  await assert.rejects(mismatch.service.update(documentId, mismatch.request, { sourceSha256: mismatch.sourceSha256 }), { code: 'TAGGED_PDF_REMEDIATION_OUTPUT_INVALID' });
  assert.equal(mismatch.observed.promoted, 0);
});

test('tagged remediation cancellation cleans private work and maps to JOB_CANCELLED', async (context) => {
  const controller = new AbortController();
  const setupValue = await setup(context, { core: {
    normalizeTaggedPdfRemediation: (value) => value,
    writeTaggedPdfRemediation(source, req) { controller.abort(new Error('cancel')); return writeTaggedPdfRemediation(source, req); },
    inspectTaggedPdfRemediation,
  } });
  await assert.rejects(setupValue.service.update(documentId, setupValue.request, { sourceSha256: setupValue.sourceSha256, signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(setupValue.observed.promoted, 0);
});

test('tagged remediation rejects output mode and replacement tampering before promotion', async (context) => {
  for (const tamper of ['mode', 'replacement']) {
    const setupValue = await setup(context, { core: {
      normalizeTaggedPdfRemediation: (value) => value,
      writeTaggedPdfRemediation,
      inspectTaggedPdfRemediation: (...args) => {
        if (tamper === 'mode') { chmodSync(setupValue.observed.outputPath, 0o600); return inspectTaggedPdfRemediation(...args); }
        unlinkSync(setupValue.observed.outputPath); writeFileSync(setupValue.observed.outputPath, Buffer.from('tampered-output'), { mode: 0o400 }); return inspectTaggedPdfRemediation(...args);
      },
    } });
    await assert.rejects(setupValue.service.update(documentId, setupValue.request, { sourceSha256: setupValue.sourceSha256 }), { code: 'TAGGED_PDF_REMEDIATION_OUTPUT_INVALID' });
    assert.equal(setupValue.observed.promoted, 0);
  }
});
