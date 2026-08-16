import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDocumentReadRoute } from '../scripts/host/routes/document-service-route-read.mjs';
import { handleRasterMutationRoute } from '../scripts/host/routes/workflow-mutation-routes.mjs';
import { handleWorkflowRoute } from '../scripts/host/routes/workflow-routes.mjs';
import { handleWorkspaceRoute } from '../scripts/host/routes/workspace-routes.mjs';

test('raster route rejects inherited operation names and preserves a mapped operation', async () => {
  let calls = 0;
  const context = (operation) => ({
    request: {}, response: {}, documentId: 'document', processing: {},
    rasterMutations: { rotatePages: async () => { calls += 1; return { id: 'artifact' }; } },
    method: () => {}, readJson: async () => ({ operation }), json: () => {},
  });
  for (const operation of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(handleRasterMutationRoute(context(operation)), { code: 'INVALID_OPERATION', status: 400 });
  }
  await handleRasterMutationRoute(context('rotate'));
  assert.equal(calls, 1);
});

test('workspace route rejects inherited AEC selectors and preserves its mapped operation', async () => {
  let calls = 0;
  const makeContext = (operation) => ({
    operation, request: { method: 'POST' }, response: {}, url: new URL('http://local/api/documents/document/aec-calibration'),
    documentId: 'document', processing: {}, aecArtifacts: { calibrate: async () => { calls += 1; return { ok: true }; } },
    method: () => {}, readJson: async () => ({}), json: () => {},
  });
  for (const operation of ['toString', 'constructor', '__proto__']) {
    assert.equal(await handleWorkspaceRoute(makeContext(operation)), false);
  }
  assert.equal(await handleWorkspaceRoute(makeContext('aec-calibration')), true);
  assert.equal(calls, 1);
});

test('document-read and workflow routes reject inherited selectors without invoking dispatch', async () => {
  let assetCalls = 0;
  for (const operation of ['toString', 'constructor', '__proto__']) {
    assert.equal(await handleDocumentReadRoute({ operation, service: { listFonts: async () => { assetCalls += 1; } } }), false);
    assert.equal(await handleWorkflowRoute({ operation }), false);
  }
  const writes = [];
  assert.equal(await handleDocumentReadRoute({
    operation: 'fonts', request: {}, response: {}, documentId: 'document', processing: {},
    service: { listFonts: async () => { assetCalls += 1; return ['Inter']; } },
    method: () => {}, json: (_response, status, value) => writes.push({ status, value }),
  }), undefined);
  assert.deepEqual(writes, [{ status: 200, value: { fonts: ['Inter'] } }]);
  assert.equal(assetCalls, 1);
});
