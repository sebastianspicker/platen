import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runAecBatchLinkCommand } from '../scripts/cli/commands/aec-batch-link.mjs';
import { INCREMENTAL_BATCH_LINK_PROFILE } from '../scripts/host/pdf-incremental-batch-link-contract.mjs';
import { PDF_INCREMENTAL_BATCH_LINK_LIMITATIONS, PDF_INCREMENTAL_BATCH_LINK_VALIDATORS } from '../scripts/host/pdf-incremental-batch-link-artifact.mjs';

const document = { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) };
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const links = [{ sourcePage: 1, targetPage: 1, rect: { left: 1, bottom: 1, right: 2, top: 2 } }];
const request = { profile: INCREMENTAL_BATCH_LINK_PROFILE, links };
const requestSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
function result() {
  const rawProof = { profile: INCREMENTAL_BATCH_LINK_PROFILE, sourceBytes: 100, outputBytes: 120, appendedBytes: 20, sourcePrefixPreserved: true, revisionCount: 2, previousXrefOffset: 10, appendedXrefOffset: 100, links: links.map((link) => ({ ...link, sourcePageObjectNumber: 3, targetPageObjectNumber: 3, linkAnnotationObjectNumber: 4 })), updatedPageObjectNumbers: [3], updatedObjectNumbers: [3], effectiveSize: 5, rootPreserved: true, infoPreserved: true, idPolicy: 'absent' };
  const artifact = { id: artifactId, documentId: document.id, displayName: 'batch.pdf', mediaType: 'application/pdf', size: 128, sha256: 'b'.repeat(64), createdAt: '2026-07-21T00:00:00.000Z', operation: { schemaVersion: 1, id: operationId, type: 'pdf-incremental-batch-link', inputs: [{ documentId: document.id, sha256: document.sha256, role: 'source' }], parameters: { profile: INCREMENTAL_BATCH_LINK_PROFILE, links, requestSha256 }, expected: { pageCount: 1, linkCount: 1, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false }, validation: { passed: true, validators: [...PDF_INCREMENTAL_BATCH_LINK_VALIDATORS], pageCount: 1, outputSha256: 'b'.repeat(64), rawProof }, completedAt: '2026-07-21T00:00:00.000Z' } };
  return { kind: 'pdf-incremental-batch-link', sourceDigest: document.sha256, artifact, links, evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, linkCount: 1, pageCount: 1, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true, pageValidationRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }, limitations: [...PDF_INCREMENTAL_BATCH_LINK_LIMITATIONS] };
}
function fixture(overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(links)); const deleted = []; const emitted = [];
  const value = result();
  const state = { bytes, deleted, emitted, application: { incrementalBatchLink: { update: async () => overrides.result ?? value }, store: { getArtifact: () => ({ ...value.artifact, filePath: '/private/batch.pdf' }), deleteArtifact: async (id) => { deleted.push(id); } } }, runtime: { cancelled() {}, readLocalInputBytes: async () => ({ bytes }), copyExclusive: async () => {}, emit: async (_stdout, output) => emitted.push(output) } };
  return { ...state, ...overrides };
}

test('batch-link CLI zeroes links bytes and deletes trusted artifact after copy', async () => {
  const state = fixture(); await runAecBatchLinkCommand(state.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, state.runtime); assert.deepEqual(state.deleted, [artifactId]); assert.equal(state.bytes.every((byte) => byte === 0), true); assert.equal(state.emitted[0].artifact.output, 'out.pdf');
});
test('batch-link CLI rejects malformed and forged results without untrusted cleanup', async () => {
  const malformed = fixture(); malformed.runtime.readLocalInputBytes = async () => ({ bytes: Buffer.from('{') }); await assert.rejects(runAecBatchLinkCommand(malformed.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, malformed.runtime), { code: 'CLI_INVALID_LINKS_JSON' }); assert.deepEqual(malformed.deleted, []);
  const forged = fixture({ result: { ...result(), sourceDigest: 'c'.repeat(64) } }); await assert.rejects(runAecBatchLinkCommand(forged.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, forged.runtime), { code: 'CLI_BATCH_LINK_RESULT_INVALID' }); assert.deepEqual(forged.deleted, []);
});
test('batch-link CLI rejects store mismatch and cleans validated artifact on copy/delete failures', async () => {
  const mismatch = fixture(); mismatch.application.store.getArtifact = () => ({ ...result().artifact, sha256: 'c'.repeat(64), filePath: '/private/batch.pdf' }); await assert.rejects(runAecBatchLinkCommand(mismatch.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, mismatch.runtime), { code: 'CLI_ARTIFACT_INVALID' }); assert.deepEqual(mismatch.deleted, []);
  const copyFailure = fixture(); copyFailure.runtime.copyExclusive = async () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); }; await assert.rejects(runAecBatchLinkCommand(copyFailure.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, copyFailure.runtime), { code: 'JOB_CANCELLED' }); assert.deepEqual(copyFailure.deleted, [artifactId]);
  const deleteFailure = fixture(); deleteFailure.application.store.deleteArtifact = async () => { throw Object.assign(new Error('delete failed'), { code: 'STORE_DELETE_FAILED' }); }; await assert.rejects(runAecBatchLinkCommand(deleteFailure.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, deleteFailure.runtime), { code: 'STORE_DELETE_FAILED' });
});
test('batch-link CLI cancellation before service and during copy is typed', async () => {
  const before = fixture(); before.runtime.cancelled = () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); }; await assert.rejects(runAecBatchLinkCommand(before.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, before.runtime), { code: 'JOB_CANCELLED' });
  const during = fixture(); let count = 0; during.runtime.cancelled = () => { count += 1; if (count > 1) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); }; during.runtime.copyExclusive = async () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); }; await assert.rejects(runAecBatchLinkCommand(during.application, { links: 'links.json', output: '/tmp/out.pdf' }, document, null, undefined, during.runtime), { code: 'JOB_CANCELLED' }); assert.deepEqual(during.deleted, [artifactId]);
});
