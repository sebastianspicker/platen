import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccessibilityRemediationService, ACCESSIBILITY_REMEDIATION_MAX_EXPORT_BYTES, ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS, canonicalizeAccessibilityRemediationProposal } from '../scripts/host/accessibility-remediation-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '123e4567-e89b-42d3-a456-426614174000';
const sourceSha256 = 'a'.repeat(64);
function review() {
  const unsigned = {
    kind: 'accessibility-review', sourceDigest: sourceSha256, status: 'review-required',
    remediationPlan: {
      candidates: [
        { id: 'candidate-1', action: 'author-tag-tree', status: 'proposed-not-applied' },
        { id: 'candidate-2', action: 'author-image-alt-text', status: 'proposed-not-applied', target: { locator: 'b'.repeat(64) } },
      ],
    },
  };
  return { ...unsigned, reportSha256: createHash('sha256').update(canonicalizeAccessibilityRemediationProposal(unsigned)).digest('hex') };
}
function setup({ currentReview = review(), verify = async () => true } = {}) {
  const workspace = new WorkspaceStateStore((id) => id === documentId);
  const documents = { getDocument: (id) => { if (id !== documentId) throw new Error('missing'); return { id, sha256: sourceSha256 }; }, verifySource: verify };
  const service = new AccessibilityRemediationService({ documentStore: documents, workspaceStateStore: workspace, reviewProvider: { review: async () => currentReview }, idFactory: () => 'accessibility-proposal-1' });
  return { workspace, service, currentReview };
}
function request(currentReview, operations = [{ action: 'author-tag-tree', target: null }]) { return { sourceSha256, reviewSha256: currentReview.reportSha256, expectedWorkspaceRevision: 0, operations }; }

test('proposal is atomically stored once, source/review-bound, non-applying, and exported only by server ID', async () => {
  const { workspace, service, currentReview } = setup();
  const created = await service.createProposal(documentId, request(currentReview, [{ action: 'author-image-alt-text', target: { locator: 'b'.repeat(64) }, authoredText: '  cafe\u0301 photo  ' }]));
  assert.deepEqual(created, { proposalId: 'accessibility-proposal-1', revision: 1, status: 'proposed-not-applied', pdfWriterRequired: true, conformanceClaim: false });
  const state = workspace.snapshot(documentId); assert.equal(state.revision, 1); assert.equal(state.namespaces.accessibilityTags.length, 1);
  const exported = service.exportProposal(documentId, created.proposalId);
  assert.equal(exported, canonicalizeAccessibilityRemediationProposal(JSON.parse(exported)));
  const proposal = JSON.parse(exported);
  assert.equal(proposal.operations[0].status, 'proposed-not-applied'); assert.equal(proposal.operations[0].pdfWriterRequired, true); assert.equal(proposal.conformanceClaim, false);
  assert.equal(proposal.operations[0].authoredText, 'caf\u00e9 photo');
  assert.doesNotMatch(exported, /private|page text|image bytes/i);
  assert.throws(() => service.exportProposal(documentId, 'not a proposal'), { code: 'ACCESSIBILITY_PROPOSAL_INVALID' });
});

test('author-entered image alt text is bounded, target-bound, and never inferred', async () => {
  const invalid = async (operations, code = 'ACCESSIBILITY_PROPOSAL_INVALID') => {
    const { service, currentReview } = setup();
    await assert.rejects(service.createProposal(documentId, request(currentReview, operations)), { code });
  };
  const imageTarget = { locator: 'b'.repeat(64) };
  await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText: '' }]);
  await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText: ' '.repeat(1001) }]);
  await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText: 'good\u0000bad' }]);
  await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText: 'good\u202Ebad' }]);
  await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText: '\uD800' }]);
  for (const authoredText of ['/private/input.pdf', '~/input.pdf', './input.pdf', '../input.pdf', 'C:\\input.pdf', '\\\\server\\share']) {
    await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText }]);
  }
  await invalid([{ action: 'author-tag-tree', target: null, authoredText: 'not allowed' }]);
  await invalid([{ action: 'author-image-alt-text', target: imageTarget }]);
  await invalid([{ action: 'author-image-alt-text', target: null, authoredText: 'missing locator' }]);
  await invalid([{ action: 'author-image-alt-text', target: {}, authoredText: 'missing locator' }]);
  await invalid([{ action: 'author-image-alt-text', target: imageTarget, authoredText: 'text', unexpected: true }]);
  await invalid([
    { action: 'author-image-alt-text', target: imageTarget, authoredText: 'first' },
    { action: 'author-image-alt-text', target: imageTarget, authoredText: 'second' },
  ], 'ACCESSIBILITY_PROPOSAL_DUPLICATE_TARGET');
  await invalid([{ action: 'author-image-alt-text', target: { locator: 'c'.repeat(64) }, authoredText: 'unknown target' }], 'ACCESSIBILITY_PROPOSAL_NOT_IN_REVIEW');

  const { workspace, service, currentReview } = setup();
  const created = await service.createProposal(documentId, request(currentReview));
  const stored = workspace.snapshot(documentId).namespaces.accessibilityTags[0];
  assert.equal(Object.hasOwn(stored.operations[0], 'authoredText'), false);
  assert.equal(created.status, 'proposed-not-applied');
});

test('proposal rejects extra keys, stale source/review/revision, altered trusted reports, and oversized operation lists without writes', async () => {
  const { workspace, service, currentReview } = setup();
  await assert.rejects(service.createProposal(documentId, { ...request(currentReview), extra: true }), { code: 'ACCESSIBILITY_PROPOSAL_INVALID' });
  await assert.rejects(service.createProposal(documentId, { ...request(currentReview), sourceSha256: 'b'.repeat(64) }), { code: 'ACCESSIBILITY_PROPOSAL_SOURCE_MISMATCH', status: 409 });
  await assert.rejects(service.createProposal(documentId, { ...request(currentReview), reviewSha256: 'b'.repeat(64) }), { code: 'ACCESSIBILITY_PROPOSAL_REVIEW_STALE', status: 409 });
  await assert.rejects(service.createProposal(documentId, request(currentReview, [{ action: 'invent-untested-fix', target: null }])), { code: 'ACCESSIBILITY_PROPOSAL_NOT_IN_REVIEW', status: 409 });
  await assert.rejects(service.createProposal(documentId, request(currentReview, [])), { code: 'ACCESSIBILITY_PROPOSAL_OPERATION_LIMIT', status: 413 });
  await assert.rejects(service.createProposal(documentId, request(currentReview, Array.from({ length: ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS + 1 }, () => ({ action: 'review', target: null })))), { code: 'ACCESSIBILITY_PROPOSAL_OPERATION_LIMIT', status: 413 });
  const tampered = { ...currentReview, reportSha256: 'c'.repeat(64) };
  await assert.rejects(setup({ currentReview: tampered }).service.createProposal(documentId, request(tampered)), { code: 'ACCESSIBILITY_REVIEW_INTEGRITY_FAILED', status: 502 });
  workspace.createEntity(documentId, 'annotations', { id: 'concurrent' });
  await assert.rejects(service.createProposal(documentId, request(currentReview)), { code: 'REVISION_CONFLICT', status: 409 });
  assert.equal(workspace.snapshot(documentId).namespaces.accessibilityTags.length, 0);
});

test('proposal export rejects malformed stored records and enforces a canonical 128 KiB bound', async () => {
  const { workspace, service, currentReview } = setup();
  const created = await service.createProposal(documentId, request(currentReview));
  const snapshot = structuredClone(workspace.snapshot(documentId));
  snapshot.namespaces.accessibilityTags[0].unexpected = true;
  workspace.replaceSnapshot(documentId, snapshot, { expectedRevision: created.revision });
  assert.throws(() => service.exportProposal(documentId, created.proposalId), { code: 'ACCESSIBILITY_PROPOSAL_INVALID' });
  assert.ok(ACCESSIBILITY_REMEDIATION_MAX_EXPORT_BYTES === 128 * 1024);
});

test('proposal export accepts only its own unchanged successful issuances', async () => {
  const { workspace, service, currentReview } = setup();
  const injected = {
    schemaVersion: 1, id: 'accessibility-proposal-1', type: 'accessibility-remediation-proposal', status: 'proposed-not-applied',
    sourceSha256, reviewSha256: currentReview.reportSha256, expectedWorkspaceRevision: 0,
    pdfWriterRequired: true, conformanceClaim: false,
    operations: [{ id: 'operation-1', action: 'author-tag-tree', target: null, status: 'proposed-not-applied', pdfWriterRequired: true, conformanceClaim: false }],
  };
  workspace.createEntity(documentId, 'accessibilityTags', injected, { expectedRevision: 0 });
  assert.throws(() => service.exportProposal(documentId, injected.id), { code: 'ACCESSIBILITY_PROPOSAL_NOT_ISSUED', status: 404 });
  await assert.rejects(service.createProposal(documentId, { ...request(currentReview, [{ action: 'author-tag-tree', target: null }]), expectedWorkspaceRevision: 1 }), { code: 'ENTITY_EXISTS', status: 409 });

  const { workspace: issuedWorkspace, service: issuedService, currentReview: issuedReview } = setup();
  const created = await issuedService.createProposal(documentId, request(issuedReview));
  const replacement = structuredClone(issuedWorkspace.snapshot(documentId).namespaces.accessibilityTags[0]);
  replacement.reviewSha256 = 'c'.repeat(64);
  issuedWorkspace.updateEntity(documentId, 'accessibilityTags', created.proposalId, replacement, { expectedRevision: created.revision });
  assert.throws(() => issuedService.exportProposal(documentId, created.proposalId), { code: 'ACCESSIBILITY_PROPOSAL_ISSUANCE_MISMATCH', status: 409 });
});
