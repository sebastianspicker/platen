import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { PdfTaggedRemediationService } from '../scripts/host/pdf-tagged-remediation-service.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../scripts/host/pdf-tagged-remediation-contract.mjs';
import { inspectTaggedPdfRemediation, writeTaggedPdfRemediation } from '../scripts/host/pdf-tagged-remediation-writer.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';

function existingSiblingFixture() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo 7 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 11 0 R] /StructParents 0 >>');
  const stream = (mcid) => `/P <</MCID ${mcid}>> BDC\nq\nQ\nEMC\n`;
  for (const [number, mcid] of [[4, 0], [11, 1]]) { const bytes = stream(mcid); offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n<< /Length ${Buffer.byteLength(bytes, 'latin1')} >>\nstream\n${bytes}endstream\nendobj\n`); }
  object(5, '<< /Type /Pages >>'); object(6, '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 9 0 R >>'); object(7, '<< /Marked true >>');
  object(8, '<< /Type /StructElem /S /Document /P 6 0 R /K [10 0 R 12 0 R] >>'); object(9, '<< /Nums [0 [10 0 R 12 0 R]] >>'); object(10, '<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID 0 >>] >>'); object(12, '<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID 1 >>] >>');
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 13\n0000000000 65535 f \n'); for (let number = 1; number <= 12; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`); chunks.push(`trailer\n<< /Size 13 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function child(id, object, content, mcid, role = 'P') {
  return { id, role, structRef: { object, generation: 0 }, page: 1, contentIndex: content, contentRef: { object: content === 0 ? 4 : 11, generation: 0 }, mcid };
}
function request(source, children = [child('second', 12, 1, 1), child('first', 10, 0, 0)]) {
  return {
    profile: TAGGED_PDF_REMEDIATION_PROFILE,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    plan: { mode: 'existing-structure-v1', id: 'document', role: 'Document', structRef: { object: 8, generation: 0 }, children },
    language: null, title: null, roleMap: {},
  };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r07-reading-order-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = existingSiblingFixture(); const sourceSha256 = createHash('sha256').update(source).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const observed = { output: null, promoted: 0, deleted: [] };
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => { const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex'); if (digest !== sourceSha256) throw new Error('source changed'); },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => rm(path, { recursive: true, force: true }),
    promotePdfArtifact: async (_id, path, promotion) => { observed.promoted += 1; observed.output = await readFile(path); return { id: artifactId, documentId, displayName: 'tagged-reading-order.pdf', mediaType: 'application/pdf', size: observed.output.length, sha256: promotion.expectedSha256, operation: promotion.operation, createdAt: '2026-08-03T00:00:00.000Z' }; },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  return { source, sourceSha256, request: request(source), store, observed, service: new PdfTaggedRemediationService({ store }) };
}

test('accessibility.reading-order applies only a complete explicit sibling plan and preserves source-bound evidence', async (t) => {
  const state = await setup(t); const result = await state.service.update(documentId, state.request, { sourceSha256: state.sourceSha256 });
  assert.equal(result.kind, 'tagged-pdf-remediation'); assert.equal(result.profile, TAGGED_PDF_REMEDIATION_PROFILE); assert.equal(result.sourceDigest, state.sourceSha256); assert.equal(state.observed.promoted, 1);
  assert.equal(result.evidence.sourceBound, true); assert.equal(result.evidence.sourceUnchanged, true); assert.equal(result.evidence.independentInspection, true); assert.equal(result.evidence.outputDigestBound, true);
  assert.equal(result.proof.sourcePrefixPreserved, true); assert.equal(result.proof.originalContentStreamsUnchanged, true); assert.equal(result.proof.tagTreeReinspected, true); assert.equal(result.proof.textEvidence, 'content-streams-unchanged'); assert.equal(result.proof.renderingEvidence, 'page-geometry-and-content-preserved');
  assert.equal(result.proof.pageGeometry[0].mediaBox.join(','), '0,0,612,792'); assert.equal(result.proof.originalContentStreams.length, 2); assert.equal(result.artifact.sha256, result.proof.outputSha256); assert.equal(createHash('sha256').update(state.observed.output).digest('hex'), result.proof.outputSha256); assert.equal(state.observed.output.subarray(0, state.source.length).equals(state.source), true);
  assert.deepEqual(inspectTaggedPdfRemediation(state.source, state.observed.output, state.request), result.proof);
  assert.match(result.limitations.join(' '), /does not claim PDF\/UA conformance/u); assert.match(result.limitations.join(' '), /reading-order correctness/u); assert.match(result.artifact.operation.parameters.planSha256, /^[a-f0-9]{64}$/u);
});

test('reading-order remediation rejects partial, duplicate, stale, tampered, and unsupported plans without promotion', async (t) => {
  const state = await setup(t); const second = child('second', 12, 1, 1); const first = child('first', 10, 0, 0);
  const invalidPlans = [
    request(state.source, [second]),
    request(state.source, [second, second]),
    request(state.source, [child('second', 12, 1, 0), first]),
    request(state.source, [child('second', 12, 1, 1, 'Link'), first]),
  ];
  for (const invalid of invalidPlans) { await assert.rejects(state.service.update(documentId, invalid, { sourceSha256: state.sourceSha256 }), (error) => /TAGGED_PDF_REMEDIATION|INVALID_TAGGED/u.test(error.code ?? '')); assert.equal(state.observed.promoted, 0); }
  await assert.rejects(state.service.update(documentId, state.request, { sourceSha256: 'b'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  assert.equal(state.observed.promoted, 0);
  const metadata = { ...state.request, language: 'en-US' };
  await assert.rejects(state.service.update(documentId, metadata, { sourceSha256: state.sourceSha256 }), (error) => /INVALID_TAGGED_PDF_REMEDIATION/u.test(error.code ?? ''));
  assert.equal(state.observed.promoted, 0);
});
