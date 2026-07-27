import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScannerAcquisitionService } from '../scripts/host/scanner-acquisition-service.mjs';
import { SCANNER_ACQUISITION_PROFILE, parseScannerAcquisitionEnvelope } from '../scripts/host/scanner-acquisition-contract.mjs';

const DEVICE = 'scanner-' + 'a'.repeat(32);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');

function request(overrides = {}) {
  return {
    profile: SCANNER_ACQUISITION_PROFILE, deviceId: DEVICE, source: 'flatbed', duplex: false,
    color: 'gray', dpi: 300, pageCount: 1, maxBytes: 1024 * 1024, deadlineMs: 5_000, format: 'PDF', ...overrides,
  };
}

async function fixture({ runner, store } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scanner-acquire-test-'));
  await chmod(root, 0o700);
  const documents = [];
  const records = new Map();
  const service = new ScannerAcquisitionService({
    executable: '/private/scanner-helper', expectedSha256: 'b'.repeat(64), workspaceRoot: root,
    verifyExecutable: async () => {}, runner: runner ?? (async ({ stdin }) => {
      const frame = JSON.parse(stdin.toString());
      await writeFile(join(frame.destination, 'scan.pdf'), PDF, { mode: 0o600, flag: 'wx' });
      return { stdout: JSON.stringify({ version: 1, ok: true, result: { outputName: 'scan.pdf', format: 'PDF', pageCount: 1, bytes: PDF.length, digest: createHash('sha256').update(PDF).digest('hex'), evidence: { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true, scanSupport: 'supported' } }, error: null }) + '\n', stderr: '' } }),
    store: store ?? { createDocument: async (input) => { const chunks = []; for await (const chunk of input.stream) chunks.push(chunk); const bytes = Buffer.concat(chunks); const document = { id: '123e4567-e89b-42d3-a456-426614174000', displayName: 'scan.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'derived', operation: input.operation, createdAt: '2026-07-21T00:00:00.000Z' }; records.set(document.id, document); documents.push(document); return document; }, getDocument: (id) => records.get(id), verifySource: async () => true, deleteDocument: async (id) => { records.delete(id); } },
  });
  return { root, service, documents };
}

test('scanner acquisition validates a private one-page PDF and creates source-free provenance', async () => {
  const fixtureValue = await fixture();
  try {
    const result = await fixtureValue.service.acquire(request());
    assert.equal(result.kind, 'scan-acquire');
    assert.equal(result.document.size, PDF.length);
    assert.deepEqual(result.document.operation.inputs, []);
    assert.equal(result.document.operation.type, 'scan-acquire');
    assert.equal(result.evidence.sourceFree, true);
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test('scanner acquisition rejects unsupported duplex, format, identity, and accessors before helper execution', async () => {
  let calls = 0;
  const fixtureValue = await fixture({ runner: async () => { calls += 1; throw new Error('must not run'); } });
  try {
    for (const overrides of [{ duplex: true }, { format: 'JPEG' }, { deviceId: 'scanner-unknown' }, { pageCount: 2 }]) {
      await assert.rejects(fixtureValue.service.acquire(request(overrides)), { code: 'INVALID_SCANNER_ACQUISITION_OPTIONS' });
    }
    const hostile = request();
    Object.defineProperty(hostile, 'color', { enumerable: true, get() { throw new Error('getter'); } });
    await assert.rejects(fixtureValue.service.acquire(hostile), { code: 'INVALID_SCANNER_ACQUISITION_OPTIONS' });
    const proxied = new Proxy(request(), { ownKeys() { throw new Error('proxy'); } });
    await assert.rejects(fixtureValue.service.acquire(proxied), { code: 'INVALID_SCANNER_ACQUISITION_OPTIONS' });
    assert.equal(calls, 0);
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test('scanner acquisition fails closed on helper unavailability and output digest mismatch', async () => {
  const unavailable = await fixture({ runner: async () => ({ stdout: JSON.stringify({ version: 1, ok: false, result: null, error: { code: 'SCANNER_SCAN_UNSUPPORTED', reason: 'No scanner.', evidence: { api: 'ImageCaptureCore', discoveryAttempted: false, liveVerification: false, scanSupport: 'unsupported' } } }) + '\n', stderr: '' }) });
  try { await assert.rejects(unavailable.service.acquire(request()), { code: 'SCANNER_SCAN_UNSUPPORTED', status: 503 }); } finally { await rm(unavailable.root, { recursive: true, force: true }); }
  const tampered = await fixture({ runner: async ({ stdin }) => { const frame = JSON.parse(stdin.toString()); await writeFile(join(frame.destination, 'scan.pdf'), PDF, { mode: 0o600, flag: 'wx' }); return { stdout: JSON.stringify({ version: 1, ok: true, result: { outputName: 'scan.pdf', format: 'PDF', pageCount: 1, bytes: PDF.length, digest: 'c'.repeat(64), evidence: { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true, scanSupport: 'supported' } }, error: null }) + '\n', stderr: '' }; } });
  try { await assert.rejects(tampered.service.acquire(request()), { code: 'SCANNER_ACQUISITION_OUTPUT_INVALID', status: 502 }); } finally { await rm(tampered.root, { recursive: true, force: true }); }
});

test('scanner acquisition response parser rejects extra fields and invalid evidence', () => {
  const valid = { version: 1, ok: true, result: { outputName: 'scan.pdf', format: 'PDF', pageCount: 1, bytes: PDF.length, digest: createHash('sha256').update(PDF).digest('hex'), evidence: { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true, scanSupport: 'supported' } }, error: null };
  assert.equal(parseScannerAcquisitionEnvelope(valid).ok, true);
  assert.throws(() => parseScannerAcquisitionEnvelope({ ...valid, extra: true }));
  assert.throws(() => parseScannerAcquisitionEnvelope({ ...valid, result: { ...valid.result, evidence: { ...valid.result.evidence, liveVerification: false } } }));
});

test('scanner acquisition does not revoke an unrelated document when the store returns forged metadata', async () => {
  const deleted = [];
  const forged = await fixture({ store: {
    createDocument: async (input) => { for await (const chunk of input.stream) void chunk; return { id: '123e4567-e89b-42d3-a456-426614174000', mediaType: 'application/pdf', size: 1, sha256: 'd'.repeat(64), origin: 'uploaded', operation: null }; },
    getDocument: () => ({ id: '123e4567-e89b-42d3-a456-426614174000', mediaType: 'application/pdf', size: 1, sha256: 'd'.repeat(64), origin: 'uploaded', operation: null }),
    verifySource: async () => true, deleteDocument: async (id) => { deleted.push(id); },
  } });
  try {
    await assert.rejects(forged.service.acquire(request()), { code: 'SCANNER_ACQUISITION_DOCUMENT_INVALID', status: 502 });
    assert.deepEqual(deleted, []);
  } finally { await rm(forged.root, { recursive: true, force: true }); }
});

test('scanner acquisition surfaces workspace cleanup failure and revokes only its trusted document', async () => {
  const deleted = [];
  const base = await fixture();
  const records = new Map();
  const store = {
    createDocument: async (input) => { const chunks = []; for await (const chunk of input.stream) chunks.push(chunk); const bytes = Buffer.concat(chunks); const document = { id: '123e4567-e89b-42d3-a456-426614174000', displayName: 'scan.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'derived', operation: input.operation, createdAt: '2026-07-21T00:00:00.000Z' }; records.set(document.id, document); return document; },
    getDocument: (id) => records.get(id), verifySource: async () => true, deleteDocument: async (id) => { deleted.push(id); records.delete(id); },
  };
  const service = new ScannerAcquisitionService({ executable: '/private/scanner-helper', expectedSha256: 'b'.repeat(64), workspaceRoot: base.root, verifyExecutable: async () => {}, runner: async ({ stdin }) => { const frame = JSON.parse(stdin.toString()); await writeFile(join(frame.destination, 'scan.pdf'), PDF, { mode: 0o600, flag: 'wx' }); return { stdout: JSON.stringify({ version: 1, ok: true, result: { outputName: 'scan.pdf', format: 'PDF', pageCount: 1, bytes: PDF.length, digest: createHash('sha256').update(PDF).digest('hex'), evidence: { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true, scanSupport: 'supported' } }, error: null }) + '\n', stderr: '' }; }, store, removeWorkspace: async () => { throw new Error('cleanup blocked'); } });
  try {
    await assert.rejects(service.acquire(request()), { code: 'SCANNER_ACQUISITION_CLEANUP_FAILED', status: 500 });
    assert.deepEqual(deleted, ['123e4567-e89b-42d3-a456-426614174000']);
  } finally { await rm(base.root, { recursive: true, force: true }); }
});

test('scanner acquisition revokes the trusted document when post-create source verification fails', async () => {
  const deleted = [];
  const base = await fixture();
  const documents = new Map();
  const store = {
    createDocument: async (input) => { const chunks = []; for await (const chunk of input.stream) chunks.push(chunk); const bytes = Buffer.concat(chunks); const document = { id: '123e4567-e89b-42d3-a456-426614174000', displayName: 'scan.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'derived', operation: input.operation, createdAt: '2026-07-21T00:00:00.000Z' }; documents.set(document.id, document); return document; },
    getDocument: (id) => documents.get(id), verifySource: async () => { throw Object.assign(new Error('digest drift'), { code: 'SOURCE_INTEGRITY_FAILED' }); }, deleteDocument: async (id) => { deleted.push(id); documents.delete(id); },
  };
  const service = new ScannerAcquisitionService({ executable: '/private/scanner-helper', expectedSha256: 'b'.repeat(64), workspaceRoot: base.root, verifyExecutable: async () => {}, runner: async ({ stdin }) => { const frame = JSON.parse(stdin.toString()); await writeFile(join(frame.destination, 'scan.pdf'), PDF, { mode: 0o600, flag: 'wx' }); return { stdout: JSON.stringify({ version: 1, ok: true, result: { outputName: 'scan.pdf', format: 'PDF', pageCount: 1, bytes: PDF.length, digest: createHash('sha256').update(PDF).digest('hex'), evidence: { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true, scanSupport: 'supported' } }, error: null }) + '\n', stderr: '' }; }, store });
  try {
    await assert.rejects(service.acquire(request()), { code: 'SCANNER_ACQUISITION_FAILED', status: 502 });
    assert.deepEqual(deleted, ['123e4567-e89b-42d3-a456-426614174000']);
  } finally { await rm(base.root, { recursive: true, force: true }); }
});
