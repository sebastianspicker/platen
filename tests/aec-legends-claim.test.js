import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AecMeasurementLegendService } from '../scripts/host/aec-measurement-legend-service.mjs';
import { createAecMeasurementLegendEndpoints } from '../src/core/local-host-aec-measurement-legend-endpoints.js';
import { createAecWorkflowController } from '../src/controllers/aec-workflow-controller.js';
import { handleAecMeasurementLegendRoute } from '../scripts/host/routes/aec-measurement-legend-routes.mjs';
import { runAecMeasurementLegendCommand } from '../scripts/cli/commands/aec-measurement-legend.mjs';

const sourceSha256 = 'a'.repeat(64);

function sourceBinding(page = 1) {
  return {
    sha256: sourceSha256,
    page,
    displayBox: 'crop',
    box: { left: 0, bottom: 0, right: 612, top: 792 },
    rotation: 0,
    geometrySha256: 'b'.repeat(64),
  };
}

function workspaceMeasurement(id, index = 1, overrides = {}) {
  return {
    schemaVersion: 2,
    id,
    type: 'measurement',
    source: sourceBinding(1),
    calibrationId: 'scale-1',
    kind: 'distance',
    geometry: { space: 'pdf-user-space-v1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    result: { dimension: 'length', siValue: index, siUnit: 'm', displayValue: index, displayUnit: 'm' },
    label: `Label ${id}`,
    provenanceSha256: createHash('sha256').update(id).digest('hex'),
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function legendServiceResult(records) {
  const service = new AecMeasurementLegendService();
  return service.generate({
    sourceSha256,
    expectedRevision: 2,
    records: records.map((record) => ({
      sheetId: record.sheetId ?? `page-${record.source.page}`,
      page: record.source.page,
      revision: 2,
      toolId: record.toolId ?? `aec-${record.kind}`,
      styleId: record.styleId ?? 'default',
      measurement: {
        kind: 'source-bound-aec-measurement',
        schemaVersion: 1,
        sourceDigest: sourceSha256,
        workspaceRevision: 2,
        measurement: { ...record },
      },
    })),
  });
}

test('AEC legend claim controller sends bound inputs and is inert while busy/unavailable', async () => {
  const state = {
    analysis: { documentId: 'document-1', sha256: sourceSha256 },
    domainRevision: 2,
    aecMeasurementIds: ['m-2', 'm-1'],
    domainBusy: false,
    busyAction: null,
    host: { aecMeasurementLegendReady: true },
  };
  const operation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  let calls = [];
  let renderCount = 0;
  const result = legendServiceResult([workspaceMeasurement('m-2', 2), workspaceMeasurement('m-1', 1)]);
  const controller = createAecWorkflowController({
    state,
    client: {
      async generateAecMeasurementLegend(documentId, request) {
        calls.push([documentId, request]);
        return result;
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: (candidate) => candidate === operation,
    finishOperation: () => {},
    downloadDerivedArtifact: () => {},
    render: () => { renderCount += 1; },
    announce: () => {},
    confirm: () => true,
    cryptoApi: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  });

  await controller.generateAecMeasurementLegend();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls.at(-1)[0], 'document-1');
  assert.deepEqual(calls.at(-1)[1], {
    sourceSha256,
    expectedRevision: 2,
    measurementIds: ['m-2', 'm-1'],
  });
  assert.equal(renderCount >= 1, true);

  state.domainBusy = true;
  await controller.generateAecMeasurementLegend();
  assert.equal(calls.length, 1);
  state.domainBusy = false;
  state.host.aecMeasurementLegendReady = false;
  await controller.generateAecMeasurementLegend();
  assert.equal(calls.length, 1);
});

test('AEC legend claim does not download or announce on stale and cancelled completion', async () => {
  const state = {
    analysis: { documentId: 'document-1', sha256: sourceSha256 },
    domainRevision: 2,
    aecMeasurementIds: ['m-1'],
    domainBusy: false,
    busyAction: null,
    host: { aecMeasurementLegendReady: true },
    aecLegendStatus: 'idle',
    aecLegendError: null,
    aecLegendResult: null,
  };
  const operation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  let current = true;
  let release;
  const result = legendServiceResult([workspaceMeasurement('m-1', 1)]);

  const controller = createAecWorkflowController({
    state,
    client: {
      async generateAecMeasurementLegend() {
        return new Promise((resolve) => {
          release = resolve;
        }).then(() => result);
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => current,
    finishOperation: () => {},
    downloadDerivedArtifact: () => {},
    render: () => {},
    announce: () => { throw new Error('should not announce stale or cancelled completions'); },
    confirm: () => true,
    cryptoApi: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  });

  const stale = controller.generateAecMeasurementLegend();
  current = false;
  release();
  await stale;
  assert.equal(state.aecLegendStatus, 'idle');
  assert.equal(state.aecLegendResult, null);

  const cancelledController = createAecWorkflowController({
    state,
    client: {
      async generateAecMeasurementLegend() {
        const error = new Error('AEC measurement legend generation was cancelled.');
        error.code = 'JOB_CANCELLED';
        error.status = 499;
        throw error;
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    finishOperation: () => {},
    downloadDerivedArtifact: () => {},
    render: () => {},
    announce: () => { throw new Error('should not announce cancelled completion'); },
    confirm: () => true,
    cryptoApi: { randomUUID: () => '00000000-0000-4000-8000-000000000002' },
  });

  await cancelledController.generateAecMeasurementLegend();
  assert.equal(state.aecLegendStatus, 'cancelled');
  assert.equal(state.aecLegendResult, null);
});

test('AEC legend claim validates downloaded output and never writes raw measurement labels', async () => {
  const validResult = legendServiceResult([workspaceMeasurement('m-1', 1)]);
  const invalidResult = structuredClone(validResult);
  invalidResult.groups[0].measurements[0].label = 'Secret label';

  const state = {
    analysis: { documentId: 'document-1', sha256: sourceSha256 },
    domainRevision: 2,
    aecMeasurementIds: ['m-1'],
    domainBusy: false,
    busyAction: null,
    host: { aecMeasurementLegendReady: true },
    aecLegendStatus: 'idle',
    aecLegendError: null,
    aecLegendResult: null,
  };
  const operation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  let payload = '';

  const invalidController = createAecWorkflowController({
    state,
    client: { async generateAecMeasurementLegend() { return invalidResult; } },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    finishOperation: () => {},
    downloadDerivedArtifact: () => {},
    render: () => {},
    announce: () => { throw new Error('should not announce for invalid result'); },
    triggerDownload: () => { throw new Error('should not write invalid completion'); },
    confirm: () => true,
    cryptoApi: { randomUUID: () => '00000000-0000-4000-8000-000000000003' },
    BlobConstructor: class {
      constructor(chunks) {
        [this.payload] = chunks;
      }
    },
  });
  await invalidController.generateAecMeasurementLegend();
  assert.equal(state.aecLegendStatus, 'error');
  assert.equal(state.aecLegendResult, null);

  payload = '';
  const validState = {
    ...state,
    aecLegendStatus: 'idle',
    aecLegendError: null,
    aecLegendResult: null,
  };
  const validController = createAecWorkflowController({
    state: validState,
    client: { async generateAecMeasurementLegend() { return validResult; } },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    finishOperation: () => {},
    downloadDerivedArtifact: () => {},
    render: () => {},
    announce: () => {},
    confirm: () => true,
    triggerDownload: ({ blob }) => {
      payload = String(blob.payload ?? '');
    },
    cryptoApi: { randomUUID: () => '00000000-0000-4000-8000-000000000004' },
    BlobConstructor: class {
      constructor(chunks) {
        [this.payload] = chunks;
      }
    },
  });

  await validController.generateAecMeasurementLegend();
  assert.equal(validState.aecLegendStatus, 'success');
  assert.match(payload, /"labelDigest"\s*:\s*"[a-f0-9]{64}"/u);
  assert.doesNotMatch(payload, /Secret label/);
  assert.match(payload, new RegExp(validResult.groups[0].measurements[0].labelDigest, 'u'));
});

test('AEC legend route and command are fail-closed with exclusive output', async () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const document = { id, sha256: sourceSha256 };
  const response = new EventEmitter();

  const routeContext = {
    request: { method: 'POST' },
    response,
    url: new URL(`http://local/api/documents/${id}/aec-measurement-legend`),
    documentId: id,
    operation: 'aec-measurement-legend',
    processing: { signal: new AbortController().signal },
    store: { getDocument: () => ({ sha256: sourceSha256 }) },
    workspaceState: { snapshot: () => ({ revision: 2, namespaces: { measurements: [workspaceMeasurement('m-1')] } }) },
    aecMeasurementLegend: { generate: () => legendServiceResult([workspaceMeasurement('m-1')]) },
    method: () => {},
    readJson: async () => ({ sourceSha256, expectedRevision: 2, measurementIds: ['m-1'] }),
    json: (_response, _status, value) => {
      routeContext.response.value = value;
    },
  };
  await handleAecMeasurementLegendRoute(routeContext);
  assert.equal(routeContext.response.value?.result.sourceDigest, sourceSha256);

  const endpoint = createAecMeasurementLegendEndpoints({
    json: async () => ({ result: legendServiceResult([workspaceMeasurement('m-1')]) }),
  });
  let endpointRejected = false;
  try {
    endpoint.generateAecMeasurementLegend(document.id, { sourceSha256: 'bad', expectedRevision: 2, measurementIds: ['m-1'] });
    throw new Error('endpoint failure was expected');
  } catch (error) {
    endpointRejected = error.message === 'AEC measurement legend request is invalid.';
  }
  assert.equal(endpointRejected, true);

  const writes = [];
  const runtime = {
    cancelled: () => {},
    writeExclusive: async (path, value) => { writes.push([path, value]); },
    emit: async () => {},
  };
  const application = {
    workspaceState: {
      snapshot: () => ({ revision: 2, namespaces: { measurements: [workspaceMeasurement('m-1')] } }),
    },
    aecMeasurementLegend: { generate: async () => legendServiceResult([workspaceMeasurement('m-1')]) },
  };

  await runAecMeasurementLegendCommand(application, { format: 'json', output: 'legend.json' }, document, null, null, runtime);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'legend.json');
  assert.match(writes[0][1], /"labelDigest"/u);

  const csvWrites = [];
  const csvRuntime = {
    cancelled: () => {},
    writeExclusive: async (path, value) => { csvWrites.push([path, value]); },
    emit: async () => {},
  };
  const csvApplication = {
    workspaceState: {
      snapshot: () => ({ revision: 2, namespaces: { measurements: [workspaceMeasurement('m-1')] } }),
    },
    aecMeasurementLegend: { generate: async () => legendServiceResult([workspaceMeasurement('m-1')]) },
  };
  await runAecMeasurementLegendCommand(csvApplication, { format: 'csv', output: 'legend.csv' }, document, null, null, csvRuntime);
  assert.equal(csvWrites[0][0], 'legend.csv');
  assert.match(csvWrites[0][1], /^toolId,styleId,kind/u);

  const queryRejected = {
    request: { method: 'POST' },
    response: new EventEmitter(),
    url: new URL(`http://local/api/documents/${id}/aec-measurement-legend?bad=true`),
    documentId: id,
    operation: 'aec-measurement-legend',
    processing: { signal: new AbortController().signal },
    store: { getDocument: () => ({ sha256: sourceSha256 }) },
    workspaceState: { snapshot: () => ({ revision: 2, namespaces: { measurements: [] } }) },
    aecMeasurementLegend: { generate: () => ({}) },
    method: () => {},
    readJson: async () => ({ sourceSha256, expectedRevision: 2, measurementIds: ['m-1'] }),
    json: () => {},
  };
  await assert.rejects(() => handleAecMeasurementLegendRoute(queryRejected), { code: 'INVALID_PARAMETER' });
});
