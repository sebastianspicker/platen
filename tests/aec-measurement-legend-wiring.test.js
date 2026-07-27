import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { createAecMeasurementLegendEndpoints } from '../src/core/local-host-aec-measurement-legend-endpoints.js';
import { handleAecMeasurementLegendRoute } from '../scripts/host/routes/aec-measurement-legend-routes.mjs';
import { runAecMeasurementLegendCommand } from '../scripts/cli/commands/aec-measurement-legend.mjs';

const digest = 'a'.repeat(64); const id = '123e4567-e89b-12d3-a456-426614174000';
test('AEC legend parser requires explicit format bounds and exclusive output', () => {
  assert.deepEqual(parseCliArguments(['aec-measurement-legend', 'input.pdf', '--format', 'csv', '--output', 'legend.csv']), { command: 'aec-measurement-legend', input: 'input.pdf', format: 'csv', output: 'legend.csv' });
  assert.throws(() => parseCliArguments(['aec-measurement-legend', 'input.pdf', '--format', 'xml', '--output', 'legend.json']), { code: 'CLI_INVALID_OPTION' });
});
test('AEC legend client rejects duplicate IDs before POST', () => {
  let calls = 0; const endpoint = createAecMeasurementLegendEndpoints({ json: async () => { calls += 1; return { result: null }; } });
  assert.throws(() => endpoint.generateAecMeasurementLegend(id, { sourceSha256: digest, expectedRevision: 2, measurementIds: ['m-1', 'm-1'] }), TypeError); assert.equal(calls, 0);
});
test('AEC legend client accepts and freezes a source-bound result graph', async () => {
  const result = { kind: 'aec-measurement-legend', schemaVersion: 1, sourceDigest: digest, sheetRevision: 2, recordCount: 1, groups: [{ toolId: 'aec-distance', styleId: 'default', kind: 'distance', dimension: 'length', siUnit: 'm', displayUnit: 'm', calibrationId: 'scale-1', count: 1, totalSiValue: 2, measurements: [{ id: 'm-1', page: 1, sheetId: 'page-1', kind: 'distance', dimension: 'length', calibrationId: 'scale-1', displayUnit: 'm', labelDigest: 'b'.repeat(64), siValue: 2, siUnit: 'm' }], provenance: [{ id: 'm-1', provenanceSha256: 'c'.repeat(64), sourceSha256: digest, page: 1, revision: 2 }] }] };
  const endpoint = createAecMeasurementLegendEndpoints({ json: async () => ({ result }) }); const checked = await endpoint.generateAecMeasurementLegend(id, { sourceSha256: digest, expectedRevision: 2, measurementIds: ['m-1'] });
  assert.equal(Object.isFrozen(checked), true); assert.equal(Object.isFrozen(checked.groups[0].measurements[0]), true);
});
test('AEC legend route does not accept caller-supplied measurement wrappers', async () => {
  const response = new EventEmitter(); const context = { request: { method: 'POST' }, response, url: new URL(`http://local/api/documents/${id}/aec-measurement-legend`), documentId: id, operation: 'aec-measurement-legend', processing: { signal: new AbortController().signal }, store: { getDocument: () => ({ sha256: digest }) }, workspaceState: { snapshot: () => ({ revision: 2, namespaces: { measurements: [] } }) }, aecMeasurementLegend: { generate: () => { throw new Error('must not call'); } }, method: (request, expected) => assert.equal(request.method, expected), readJson: async () => ({ sourceSha256: digest, expectedRevision: 2, measurementIds: ['m-1'], records: [] }), json: () => {} };
  await assert.rejects(handleAecMeasurementLegendRoute(context), { code: 'INVALID_AEC_LEGEND_OPTIONS' });
});
test('AEC legend route derives the wrapper from trusted workspace records and current revision', async () => {
  const measurement = { schemaVersion: 2, id: 'm-1', type: 'measurement', source: { sha256: digest, page: 1, displayBox: 'crop', box: { left: 0, bottom: 0, right: 100, top: 100 }, rotation: 0, geometrySha256: 'b'.repeat(64) }, calibrationId: 'scale-1', kind: 'distance', geometry: { space: 'pdf-user-space-v1', points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }, result: { dimension: 'length', siValue: 2, siUnit: 'm', displayValue: 2, displayUnit: 'm' }, label: 'secret label', provenanceSha256: 'c'.repeat(64), createdAt: '2026-07-20T00:00:00.000Z' };
  const response = new EventEmitter(); let generated = null; const context = { request: { method: 'POST' }, response, url: new URL(`http://local/api/documents/${id}/aec-measurement-legend`), documentId: id, operation: 'aec-measurement-legend', processing: { signal: new AbortController().signal }, store: { getDocument: () => ({ sha256: digest }) }, workspaceState: { snapshot: () => ({ revision: 2, namespaces: { measurements: [measurement] } }) }, aecMeasurementLegend: { generate: (request) => { generated = request; return { kind: 'aec-measurement-legend', schemaVersion: 1, sourceDigest: digest, sheetRevision: 2, groups: [], recordCount: 0 }; } }, method: () => {}, readJson: async () => ({ sourceSha256: digest, expectedRevision: 2, measurementIds: ['m-1'] }), json: (_response, _status, value) => { response.value = value; } };
  assert.equal(await handleAecMeasurementLegendRoute(context), true); assert.equal(generated.records[0].measurement.measurement.label, 'secret label'); assert.equal(generated.records[0].measurement.workspaceRevision, 2);
});
test('AEC legend CLI writes explicit JSON/CSV output only after cancellation gate', async () => {
  const result = { kind: 'aec-measurement-legend', sourceDigest: digest, sheetRevision: 2, recordCount: 1, groups: [{ toolId: 'aec-distance', styleId: 'default', kind: 'distance', dimension: 'length', displayUnit: 'm', count: 1, totalSiValue: 2, measurements: [{ id: 'm-1', page: 1, sheetId: 'page-1', labelDigest: 'b'.repeat(64), siValue: 2, siUnit: 'm' }] }] };
  const writes = []; const app = { workspaceState: { snapshot: () => ({ revision: 2, namespaces: { measurements: [] } }) }, aecMeasurementLegend: { generate: async () => result } }; const runtime = { cancelled: () => {}, writeExclusive: async (path, value) => writes.push([path, value]), emit: async () => {} };
  await runAecMeasurementLegendCommand(app, { format: 'json', output: 'legend.json' }, { id, sha256: digest }, null, null, runtime).catch((error) => assert.equal(error.code, 'AEC_MEASUREMENT_NOT_FOUND'));
  assert.equal(writes.length, 0);
});
