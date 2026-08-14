import assert from 'node:assert/strict';
import test from 'node:test';
import { createScannerAcquisitionEndpoints } from '../src/core/local-host-scanner-acquisition-endpoints.js';
import { LocalHostClient } from '../src/core/local-host-client.js';

const deviceId = `scanner-${'a'.repeat(32)}`;
const sha256 = 'b'.repeat(64);
function response() {
  const operation = {
    schemaVersion: 1, id: '123e4567-e89b-42d3-a456-426614174001', type: 'scan-acquire', inputs: [],
    parameters: { profile: 'local-scan-acquire-v1', deviceId, source: 'flatbed', duplex: false, color: 'color', dpi: 300, pageCount: 1, format: 'PDF' },
    expected: { pageCount: 1, outputSha256: sha256, sourceFree: true },
    validation: { passed: true, validators: ['pinned-helper-sha256', 'private-workspace', 'scanner-output-identity', 'scanner-output-digest', 'pdf-header', 'single-page-acquisition'], outputSha256: sha256 }, completedAt: '2026-08-05T00:00:00.000Z',
  };
  return { document: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: 'scan.pdf', mediaType: 'application/pdf', size: 1, sha256, origin: 'derived', operation, createdAt: '2026-08-05T00:00:01.000Z' }, operation, evidence: { sourceFree: true, pageCount: 1, helperVerified: true, outputDigestBound: true, localOnly: true } };
}

test('scanner acquisition client sends an exact request and freezes only a fully digest-bound response', async () => {
  const calls = []; const controller = new AbortController();
  const endpoints = createScannerAcquisitionEndpoints({ json: async (path, options) => { calls.push({ path, options }); return response(); } });
  const result = await endpoints.acquireScanner({ deviceId, color: 'color', dpi: 300, signal: controller.signal });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.document));
  assert.equal(calls[0].path, '/api/scanners/acquire');
  assert.deepEqual(JSON.parse(calls[0].options.body), { deviceId, color: 'color', dpi: 300 });
  assert.equal(calls[0].options.signal, controller.signal);
  for (const invalid of [{ deviceId, color: 'color', dpi: 300, extra: true }, { deviceId: 'scanner-1', color: 'color', dpi: 300 }, { deviceId, color: 'rgba', dpi: 300 }, { deviceId, color: 'color', dpi: 301 }, { deviceId, color: 'color', dpi: 300, signal: {} }]) assert.throws(() => endpoints.acquireScanner(invalid), TypeError);
  const tampered = response(); tampered.operation.expected.outputSha256 = 'c'.repeat(64);
  await assert.rejects(createScannerAcquisitionEndpoints({ json: async () => tampered }).acquireScanner({ deviceId, color: 'color', dpi: 300 }), TypeError);
});

test('local host client exposes scanner acquisition through its authenticated facade', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: 'a'.repeat(64) }), { status: 200 });
    return new Response(JSON.stringify(response()), { status: 201 });
  } });
  await client.bootstrap();
  await client.acquireScanner({ deviceId, color: 'color', dpi: 300 });
  assert.equal(calls[1].path, '/api/scanners/acquire');
  assert.equal(calls[1].options.headers['X-Platen-Token'], 'a'.repeat(64));
});
