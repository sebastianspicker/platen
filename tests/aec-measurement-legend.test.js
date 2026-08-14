import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AecMeasurementLegendService } from '../scripts/host/aec-measurement-legend-service.mjs';
import { validateAecMeasurementLegendResult } from '../scripts/host/aec-measurement-legend-contract.mjs';

const sourceSha256 = 'a'.repeat(64);
const binding = { sha256: sourceSha256, page: 1, displayBox: 'crop', box: { left: 0, bottom: 0, right: 612, top: 792 }, rotation: 0, geometrySha256: 'b'.repeat(64) };
function measurement(id, value = 2) {
  return { kind: 'source-bound-aec-measurement', schemaVersion: 1, sourceDigest: sourceSha256, workspaceRevision: 3, measurement: {
    schemaVersion: 2, id, type: 'measurement', source: binding, calibrationId: 'scale-1', kind: 'distance',
    geometry: { space: 'pdf-user-space-v1', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }] },
    result: { dimension: 'length', siValue: value, siUnit: 'm', displayValue: value, displayUnit: 'm' },
    label: `Measure ${id}`, provenanceSha256: createHash('sha256').update(id).digest('hex'), createdAt: '2026-07-20T00:00:00.000Z',
  } };
}
function request(records = [{ sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-2', 2) }]) {
  return { sourceSha256, expectedRevision: 3, records };
}
function countMeasurement(id) {
  const value = measurement(id, 3);
  value.measurement.calibrationId = null;
  value.measurement.kind = 'count';
  value.measurement.geometry.points = [{ x: 10, y: 10 }];
  value.measurement.result = { dimension: 'count', siValue: 3, siUnit: 'count', displayValue: 3, displayUnit: 'count' };
  return value;
}

test('AEC measurement legend groups deterministic source-bound records and aggregates SI values', () => {
  const service = new AecMeasurementLegendService();
  const value = service.generate(request([
    { sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-2', 2) },
    { sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-1', 1) },
  ]));
  assert.equal(value.kind, 'aec-measurement-legend');
  assert.equal(value.recordCount, 2);
  assert.equal(value.groups[0].count, 2);
  assert.equal(value.groups[0].totalSiValue, 3);
  assert.deepEqual(value.groups[0].measurements.map(({ id }) => id), ['m-1', 'm-2']);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.groups[0]), true);
});

test('AEC measurement legend rejects mixed binding and hostile descriptor surfaces', () => {
  const service = new AecMeasurementLegendService();
  assert.throws(() => service.generate(request([{ sheetId: 'sheet-1', page: 1, revision: 2, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-1') }])), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
  const hostile = request();
  Object.defineProperty(hostile.records[0], 'toolId', { enumerable: true, get: () => 'tool-distance' });
  assert.throws(() => service.generate(hostile), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
  const symbol = request(); symbol.records[0][Symbol('extra')] = true;
  assert.throws(() => service.generate(symbol), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
});

test('AEC measurement legend permits heterogeneous kind groups but rejects duplicate and stale records', () => {
  const service = new AecMeasurementLegendService();
  const mixed = service.generate(request([
    { sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-count', styleId: 'style-red', measurement: countMeasurement('count-1') },
    { sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-1', 1) },
  ]));
  assert.equal(mixed.groups.length, 2);
  assert.throws(() => service.generate(request([
    { sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-1', 1) },
    { sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-1', 2) },
  ])), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
  assert.throws(() => service.generate(request([{ sheetId: 'sheet-1', page: 1, revision: 2, toolId: 'tool-distance', styleId: 'style-blue', measurement: measurement('m-3') }])), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
});

test('AEC measurement legend cancellation, output tampering, and post-call mutation fail closed', () => {
  const service = new AecMeasurementLegendService();
  const input = request(); const output = service.generate(input); input.records[0].toolId = 'mutated';
  assert.equal(output.groups[0].toolId, 'tool-distance');
  const tampered = structuredClone(output); tampered.groups[0].totalSiValue += 1;
  assert.throws(() => validateAecMeasurementLegendResult(tampered), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => service.generate(request(), { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.throws(() => service.generate(request(), { signal: { aborted: false } }), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
  const setterOptions = {}; Object.defineProperty(setterOptions, 'signal', { enumerable: true, set: () => {} });
  assert.throws(() => service.generate(request(), setterOptions), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
  const fractionalCount = countMeasurement('count-fraction'); fractionalCount.measurement.result.siValue = 1.5;
  assert.throws(() => service.generate(request([{ sheetId: 'sheet-1', page: 1, revision: 3, toolId: 'tool-count', styleId: 'style-red', measurement: fractionalCount }])), { code: 'AEC_LEGEND_CONTRACT_INVALID' });
});
