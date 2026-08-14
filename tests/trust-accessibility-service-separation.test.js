import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import {
  AccessibilityDomainService,
  RedactionDomainService,
  SigningDomainService,
  TrustAccessibilityDomainService,
} from '../scripts/host/domains/trust-accessibility.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const options = { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (() => { let id = 0; return (prefix) => `${prefix}-${++id}`; })() };

test('trust accessibility owners expose only their bounded operation family', () => {
  const workspace = new WorkspaceStateStore((value) => value === documentId);
  const redaction = new RedactionDomainService(workspace, options);
  const accessibility = new AccessibilityDomainService(workspace, options);
  const signing = new SigningDomainService(workspace, options);

  assert.equal(typeof redaction.detectSensitiveText, 'function');
  assert.equal(typeof redaction.inspectAccessibility, 'undefined');
  assert.equal(typeof accessibility.inspectAccessibility, 'function');
  assert.equal(typeof accessibility.createElectronicSigningIntent, 'undefined');
  assert.equal(typeof signing.createElectronicSigningIntent, 'function');
  assert.equal(typeof signing.detectSensitiveText, 'undefined');
});

test('the deprecated facade delegates to owners without changing the direct-import contract', () => {
  const workspace = new WorkspaceStateStore((value) => value === documentId);
  const domain = new TrustAccessibilityDomainService(workspace, options);
  const report = domain.inspectAccessibility({ tagged: true, title: 'Accessible', language: 'en' });
  assert.equal(report.summary.issueCount, 0);
  assert.equal(domain.detectSensitiveText([{ text: 'a@b.com' }]).length, 1);
  assert.equal(domain.certificateTrust().operation, 'certificate-trust');
});
