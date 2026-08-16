import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitArtifactRunner } from '../src/controllers/pdfkit-workflow/artifact-runner.js';
import { icon } from '../src/ui/icons.js';
import { brandAndMenu } from '../src/ui/shared.js';
import { workflowsView } from '../src/ui/workflows-view.js';
import { createProfessionalAccessibilityDelivery } from '../scripts/host/professional-accessibility-delivery.mjs';

test('artifact runner rejects inherited and prototype method selectors before client dispatch', async () => {
  const errors = [];
  const calls = [];
  const runner = createPdfKitArtifactRunner({
    state: { analysis: { documentId: 'document', sha256: 'a'.repeat(64) } },
    client: { runPdfKitMutation: async (...args) => { calls.push(args); return { artifact: { id: 'artifact' } }; } },
    captureOperation: () => ({ documentId: 'document', controller: new globalThis.AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error),
    finishOperation: () => {}, render: () => {},
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
  });
  for (const method of ['__proto__', 'constructor', 'toString', 'unknownArtifactCapability']) {
    await runner.runArtifact({ method, mutation: {}, busyAction: 'test', message: () => 'test', resultKey: 'result' });
  }
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((error) => error instanceof TypeError && error.message === 'Unknown PDFKit artifact capability'));

  await runner.runArtifact({ method: 'runPdfKitMutation', mutation: { page: 1 }, busyAction: 'test', message: () => 'test', resultKey: 'result' });
  assert.deepEqual(calls, [['document', 'a'.repeat(64), { page: 1 }, { signal: calls[0][3].signal }]]);
});

test('accessibility delivery and UI tables ignore inherited selector keys', async () => {
  const delivery = createProfessionalAccessibilityDelivery({ store: {}, services: {}, deliver: async () => {}, list: () => [] });
  for (const capabilityId of ['__proto__', 'constructor', 'toString']) {
    await assert.rejects(
      delivery.deliverSourceBound(capabilityId, 'document', {}, {}),
      { code: 'PROFESSIONAL_ACCESSIBILITY_CAPABILITY_UNSUPPORTED', status: 404 },
    );
  }
  assert.equal(icon('__proto__'), icon('unknown-icon'));
  const hostileLabel = icon('folder', '\"><img src=x onerror=alert(1)>');
  assert.match(hostileLabel, /aria-label="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.doesNotMatch(hostileLabel, /aria-label=""><img/);
  assert.match(brandAndMenu('constructor'), /Workspace/);
  assert.match(brandAndMenu('__proto__'), /Workspace/);

  const inheritedOperations = Object.create({ review: { inherited: { supported: true } } });
  const html = workflowsView({
    document: { isOpen: true, id: 'document', name: 'source.pdf' },
    analysis: { documentId: 'document' }, host: {}, domainOperations: inheritedOperations,
    selectedDomainOperation: { group: 'review', operation: 'inherited' },
    domainPayload: '{}', domainBusy: false, busyAction: null,
  });
  assert.match(html, /data-state="unavailable"/);
  assert.doesNotMatch(html, /data-domain-group="review"/);
});
