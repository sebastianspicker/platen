import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { TrustAccessibilityDomainService } from '../scripts/host/domains/trust-accessibility.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
function service() {
  let id = 0;
  return new TrustAccessibilityDomainService(new WorkspaceStateStore((value) => value === documentId), { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` });
}

test('redaction detection is deterministic and plans remain explicitly not applied', () => {
  const domain = service();
  const pages = [{ pageNumber: 1, text: 'Mail a@b.com, call +1 (415) 555-2671, card 4111 1111 1111 1111, client ALPHA.' }];
  const marks = domain.detectSensitiveText(pages, { customPatterns: [{ label: 'Client', literal: 'ALPHA' }] });
  assert.deepEqual(marks.map((mark) => mark.kind), ['email', 'phone', 'payment-card', 'custom-literal']);
  const snapshot = domain.createRedactionPlan(documentId, { pages, customPatterns: [{ label: 'Client', literal: 'ALPHA' }], rectangles: [{ pageNumber: 1, rectangle: { x: 1, y: 2, width: 3, height: 4 } }], fullPages: [2] }, { expectedRevision: 0 });
  const plan = snapshot.namespaces.redactions[0];
  assert.equal(plan.status, 'proposed-not-applied');
  assert.equal(plan.marks.length, 6);
  assert.equal(plan.report.byteRemovalClaim, false);
  assert.deepEqual(domain.applyRedactions(documentId, plan.id), { status: 'not-applied', code: 'RASTER_SEMANTIC_VERIFIER_REQUIRED', bytesRemoved: false, message: 'No PDF bytes were changed; a separate raster and semantic verifier is required.' });
  const expressionMarks = domain.detectSensitiveText([{ pageNumber: 1, text: 'SSN 123-45-6789' }], { customPatterns: [{ label: 'SSN', pattern: '\\d{3}-\\d{2}-\\d{4}', regex: true }] });
  assert.deepEqual(expressionMarks.filter(({ kind }) => kind === 'custom-regex').map(({ kind, textRange }) => ({ kind, textRange })), [{ kind: 'custom-regex', textRange: { start: 4, end: 15 } }]);
  assert.throws(() => domain.detectSensitiveText(pages, { customPatterns: [{ pattern: '(a+)+$', regex: true }] }), /restricted bounded syntax/);
});

test('accessibility inspection exports reports and only stores remediation proposals', () => {
  const domain = service();
  const summary = { tagged: false, unicodeMapped: false, fontsEmbedded: false, pages: [{ pageNumber: 2, empty: true }], images: [{ pageNumber: 1, altText: '' }], forms: [{ pageNumber: 1, label: '' }], readingOrderIssues: [{ pageNumber: 2 }] };
  const report = domain.inspectAccessibility(summary);
  assert.equal(report.issues.length, 9);
  assert.match(domain.exportAccessibilityReport(report, 'csv'), /tagged-pdf/);
  assert.match(domain.exportAccessibilityReport(report), /inspection-only/);
  const snapshot = domain.proposeAccessibilityRemediation(documentId, summary, { expectedRevision: 0 });
  assert.equal(snapshot.namespaces.accessibilityTags[0].status, 'proposed-not-applied');
  assert.equal(snapshot.namespaces.accessibilityIssues[0].issues.length, 9);
  assert.equal(snapshot.namespaces.accessibilityTags[0].pdfWriterRequired, true);
  assert.throws(() => domain.proposeAccessibilityRemediation(documentId, summary, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
});

test('accessibility issue CSV neutralizes spreadsheet formula messages', () => {
  const domain = service();
  const report = domain.inspectAccessibility({
    tagged: true,
    title: 'Title',
    language: 'en',
    readingOrderIssues: ['=HYPERLINK("https://invalid.example")'],
  });
  assert.match(domain.exportAccessibilityReport(report, 'csv'), /"'=HYPERLINK\(""https:\/\/invalid\.example""\)"/u);
});

test('electronic signing hashes intent and verifies a local audit chain without certificate claims', () => {
  const workspace = new WorkspaceStateStore((value) => value === documentId);
  let id = 0;
  const domain = new TrustAccessibilityDomainService(workspace, { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` });
  const request = { documentDigest: 'd'.repeat(64), intent: { action: 'approve', signer: 'sam' }, consent: { accepted: true }, route: [{ recipient: 'sam' }], appearance: { pageNumber: 1, label: 'Approved' } };
  const created = domain.createElectronicSigningIntent(documentId, request, { expectedRevision: 0 });
  assert.equal(created.snapshot.namespaces.workflowRecords.length, 4);
  assert.equal(created.certificateSignature.status, 'unsupported');
  assert.deepEqual(domain.verifyLocalSigningIntent(documentId, request), { status: 'local-intent-verified', intentHash: created.intentHash, auditChainValid: true, certificateValid: false, timestampTrusted: false, recordCount: 4 });
  assert.equal(domain.verifyLocalSigningIntent(documentId, { ...request, intent: { action: 'reject' } }).status, 'local-intent-invalid');
  const tampered = structuredClone(workspace.snapshot(documentId));
  tampered.namespaces.workflowRecords[0].consent.accepted = false;
  workspace.replaceSnapshot(documentId, tampered, { expectedRevision: created.snapshot.revision });
  assert.equal(domain.verifyLocalSigningIntent(documentId, request).status, 'local-intent-invalid');
  assert.equal(domain.certificateRevocation().code, 'CERTIFICATE_OPERATION_UNSUPPORTED');
});
