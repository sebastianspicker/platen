import assert from 'node:assert/strict';
import test from 'node:test';
import { createScannerDiscoveryController } from '../src/controllers/scanner-discovery-controller.js';
import { workflowsView } from '../src/ui/workflows-view.js';

test('scanner controller acquires the fixed color 300 dpi one-page profile and records safe evidence', async () => {
  const announcements = []; let captured; let finishes = 0;
  const operation = { controller: new AbortController() };
  const state = { busyAction: null, host: { scannerAcquisitionReady: true }, scannerAcquisitionStatus: 'idle', scannerAcquisitionError: null, scannerAcquisitionResult: null, scannerAcquisitionEvidence: null };
  const client = { acquireScanner: async (options) => { captured = options; return { document: { displayName: 'scan.pdf' }, evidence: { sourceFree: true } }; } };
  const controller = createScannerDiscoveryController({ state, client, captureOperation: () => operation, operationIsCurrent: (candidate) => candidate === operation, finishOperation: () => { finishes += 1; }, render: () => {}, announce: (message) => announcements.push(message) });
  await controller.acquireScanner(`scanner-${'a'.repeat(32)}`);
  assert.deepEqual(captured, { deviceId: `scanner-${'a'.repeat(32)}`, color: 'color', dpi: 300, signal: operation.controller.signal });
  assert.equal(state.scannerAcquisitionStatus, 'success'); assert.equal(state.scannerAcquisitionEvidence.sourceFree, true);
  assert.match(announcements[0], /scan\.pdf retained/u); assert.equal(finishes, 1);
});

test('scanner workflow presents bounded acquisition controls only when acquisition is ready', () => {
  const deviceId = `scanner-${'a'.repeat(32)}`;
  const state = {
    host: { scannerDiscoveryReady: true, scannerAcquisitionReady: true }, busyAction: null,
    scannerDiscoveryStatus: 'success', scannerDevices: [{ id: deviceId, name: 'Office Scanner' }],
    scannerAcquisitionStatus: 'success', scannerAcquisitionResult: { document: { displayName: 'scan.pdf' } },
    domainOperations: {}, selectedDomainOperation: null,
  };
  const view = workflowsView(state);
  assert.match(view, /data-action="acquire-scanner"/u);
  assert.match(view, new RegExp(`data-scanner-device-id="${deviceId}"`, 'u'));
  assert.match(view, /Hardware success remains unverified until run on compatible hardware\./u);
  assert.doesNotMatch(view, /\/Users\//u);
});
