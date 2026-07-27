import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { parseScannerDiscoveryEnvelope, ScannerDiscoveryService } from '../scripts/host/scanner-discovery-service.mjs';
import { handleScannerDiscoveryRoute } from '../scripts/host/routes/scanner-discovery-routes.mjs';
import { createScannerDiscoveryEndpoints } from '../src/core/local-host-scanner-discovery-endpoints.js';

const evidence = { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: false, scanSupport: 'unsupported' };
const success = { version: 1, ok: true, result: { devices: [{ id: 'scanner-1', name: 'Office Scanner', kind: 'scanner', capabilities: ['image-acquisition-discovery'] }], evidence } };

test('scanner parser and envelope are discovery-only and bounded', () => {
  assert.deepEqual(parseCliArguments(['scanner-discovery', '--output', 'devices.json']), { command: 'scanner-discovery', output: 'devices.json' });
  assert.throws(() => parseScannerDiscoveryEnvelope(JSON.stringify({ ...success, result: { ...success.result, devices: [success.result.devices[0], success.result.devices[0]] } })));
  assert.throws(() => parseScannerDiscoveryEnvelope(`${JSON.stringify(success)}\n${JSON.stringify(success)}`));
  assert.equal(parseScannerDiscoveryEnvelope(JSON.stringify({ version: 1, ok: false, error: { code: 'SCANNER_SCAN_UNSUPPORTED', reason: 'Discovery only.', evidence } })).ok, false);
});

test('scanner helper verification, timeout, and malformed output fail closed', async () => {
  const base = { executable: '/private/scanner', expectedSha256: 'a'.repeat(64), verifyExecutable: async () => {}, runner: async () => ({ stdout: JSON.stringify(success), stderr: '' }) };
  assert.equal((await new ScannerDiscoveryService(base).discover()).result.devices[0].kind, 'scanner');
  await assert.rejects(new ScannerDiscoveryService({ ...base, verifyExecutable: async () => { throw new Error('bad'); } }).discover());
  await assert.rejects(new ScannerDiscoveryService({ ...base, runner: async () => ({ stdout: 'x'.repeat(16 * 1024 + 1), stderr: '' }) }).discover());
});

test('scanner route requires auth-provided empty body, rejects query, and fails unavailable closed', async () => {
  const response = { status: null, body: null };
  const common = { pathname: '/api/scanners/discover', request: {}, response, url: new URL('http://127.0.0.1/api/scanners/discover'), processing: { signal: new AbortController().signal }, method: (request, expected) => assert.equal(request.method ?? 'POST', expected), readJson: async () => ({}), json: (target, status, body) => { response.status = status; response.body = body; } };
  await handleScannerDiscoveryRoute({ ...common, scannerDiscoveryReady: true, scannerDiscovery: { discover: async () => success }, exactJsonObject: (value, keys) => Object.keys(value).length === keys.length });
  assert.equal(response.status, 200);
  await assert.rejects(handleScannerDiscoveryRoute({ ...common, url: new URL('http://127.0.0.1/api/scanners/discover?raw=1'), scannerDiscoveryReady: true, scannerDiscovery: { discover: async () => success }, exactJsonObject: () => true }));
  await assert.rejects(handleScannerDiscoveryRoute({ ...common, scannerDiscoveryReady: false, scannerDiscovery: null, exactJsonObject: () => true }), (error) => error.status === 503);
});

test('scanner client freezes valid results and rejects hostile options or capabilities', async () => {
  const client = createScannerDiscoveryEndpoints({ json: async () => success });
  const result = await client.discoverScanners();
  assert.ok(Object.isFrozen(result));
  assert.throws(() => client.discoverScanners(Object.defineProperty({}, 'extra', { value: 1, enumerable: false })));
  const hostile = createScannerDiscoveryEndpoints({ json: async () => ({ ...success, result: { ...success.result, devices: [{ ...success.result.devices[0], capabilities: Object.assign(['image-acquisition-discovery'], { extra: true }) }] } }) });
  await assert.rejects(hostile.discoverScanners());
});
