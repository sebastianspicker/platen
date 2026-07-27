import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import {
  SCANNER_DUPLEX_PROFILE,
  parseScannerDuplexEnvelope,
} from '../scripts/host/scanner-duplex-contract.mjs';
import { ScannerDuplexFeederService } from '../scripts/host/scanner-duplex-service.mjs';

const DEVICE = `scanner-${'a'.repeat(32)}`;
const PDF = makeMultiPagePdf(['front', 'back']);
const PDF_DIGEST = createHash('sha256').update(PDF).digest('hex');
const PAGE_DIGESTS = ['1'.repeat(64), '2'.repeat(64)];

function request(overrides = {}) {
  return {
    profile: SCANNER_DUPLEX_PROFILE,
    deviceId: DEVICE,
    source: 'feeder',
    duplex: true,
    color: 'gray',
    dpi: 300,
    pageCount: 2,
    maxPixels: 1_000,
    maxBytes: 1024 * 1024,
    deadlineMs: 5_000,
    format: 'PDF',
    ...overrides,
  };
}

function successEnvelope(overrides = {}) {
  return {
    version: 1,
    ok: true,
    result: {
      outputName: 'duplex-scan.pdf',
      format: 'PDF',
      pageCount: 2,
      bytes: PDF.length,
      digest: PDF_DIGEST,
      pages: [
        { sequence: 1, sheet: 1, side: 'front', width: 10, height: 10, pixels: 100, digest: PAGE_DIGESTS[0] },
        { sequence: 2, sheet: 1, side: 'back', width: 10, height: 10, pixels: 100, digest: PAGE_DIGESTS[1] },
      ],
      evidence: {
        api: 'ImageCaptureCore',
        discoveryAttempted: true,
        liveVerification: true,
        scanSupport: 'duplex-feeder-supported',
        persistentIdentityVerified: true,
        feederSupportAdvertised: true,
      },
      ...overrides,
    },
    error: null,
  };
}

async function fixture({ runner, store, removeWorkspace, inspection } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scanner-duplex-test-'));
  await chmod(root, 0o700);
  const frames = [];
  const inspections = [];
  const records = new Map();
  const defaultRunner = async ({ stdin }) => {
    const frame = JSON.parse(stdin.toString());
    frames.push(frame);
    await writeFile(join(frame.destination, 'duplex-scan.pdf'), PDF, { mode: 0o600, flag: 'wx' });
    return { stdout: `${JSON.stringify(successEnvelope())}\n`, stderr: '' };
  };
  const defaultStore = {
    createDocument: async (input) => {
      const chunks = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const document = {
        id: '123e4567-e89b-42d3-a456-426614174000',
        displayName: 'duplex-scan.pdf',
        mediaType: 'application/pdf',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        origin: 'derived',
        operation: input.operation,
        createdAt: '2026-07-21T00:00:00.000Z',
      };
      records.set(document.id, document);
      return document;
    },
    getDocument: (id) => records.get(id),
    verifySource: async () => true,
    deleteDocument: async (id) => { records.delete(id); },
  };
  const service = new ScannerDuplexFeederService({
    executable: '/private/scanner-helper',
    expectedSha256: 'b'.repeat(64),
    workspaceRoot: root,
    verifyExecutable: async () => {},
    runner: runner ?? defaultRunner,
    removeWorkspace,
    store: store ?? defaultStore,
    inspection: inspection ?? { inspect: async (documentId) => {
      inspections.push(documentId);
      return { pageCount: 2 };
    } },
  });
  return { root, frames, inspections, service };
}

test('duplex feeder acquisition returns exact ordered front/back metadata and source-free provenance', async () => {
  const setup = await fixture();
  try {
    const result = await setup.service.acquire(request());
    assert.equal(result.kind, 'scan-duplex-feeder');
    assert.deepEqual(result.helperReport.pages.map(({ sequence, sheet, side }) => ({ sequence, sheet, side })), [
      { sequence: 1, sheet: 1, side: 'front' },
      { sequence: 2, sheet: 1, side: 'back' },
    ]);
    assert.equal(result.operation.type, 'scan-duplex-feeder');
    assert.equal(result.operation.parameters.deviceId, DEVICE);
    assert.equal(result.evidence.feederSupportAdvertised, true);
    assert.equal(result.helperReport.authority, 'unvalidated-helper-page-report-v1');
    assert.equal(result.evidence.helperPageMetadataValidated, false);
    assert.equal(result.evidence.pdfStructureReinspected, true);
    assert.equal(Object.isFrozen(result.helperReport.pages[0]), true);
    assert.equal(setup.inspections.length, 2);
    assert.equal(setup.frames[0].operation, 'scanDuplex');
    assert.equal(setup.frames[0].source, 'feeder');
    assert.equal(setup.frames[0].duplex, true);
    assert.deepEqual(await readdir(setup.root), []);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('duplex feeder options reject confused profiles, odd bounds, accessors, and proxies before execution', async () => {
  let calls = 0;
  const setup = await fixture({ runner: async () => { calls += 1; throw new Error('must not run'); } });
  try {
    for (const overrides of [{ source: 'flatbed' }, { duplex: false }, { pageCount: 3 },
      { pageCount: 52 }, { maxPixels: 500_000_001 }, { deviceId: 'scanner-unknown' }]) {
      await assert.rejects(setup.service.acquire(request(overrides)), {
        code: 'INVALID_SCANNER_DUPLEX_OPTIONS',
      });
    }
    const accessor = request();
    Object.defineProperty(accessor, 'dpi', { enumerable: true, get() { throw new Error('getter'); } });
    await assert.rejects(setup.service.acquire(accessor), { code: 'INVALID_SCANNER_DUPLEX_OPTIONS' });
    await assert.rejects(setup.service.acquire(new Proxy(request(), {})), {
      code: 'INVALID_SCANNER_DUPLEX_OPTIONS',
    });
    assert.equal(calls, 0);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('duplex response parser rejects reordering, side confusion, and unadvertised support', () => {
  assert.equal(parseScannerDuplexEnvelope(successEnvelope()).result.pageCount, 2);
  const reordered = successEnvelope();
  reordered.result.pages[0].sequence = 2;
  assert.throws(() => parseScannerDuplexEnvelope(reordered));
  const side = successEnvelope();
  side.result.pages[1].side = 'front';
  assert.throws(() => parseScannerDuplexEnvelope(side));
  const unsupported = successEnvelope();
  unsupported.result.evidence.feederSupportAdvertised = false;
  assert.throws(() => parseScannerDuplexEnvelope(unsupported));
});

test('duplex job rejects helper bound and digest forgeries and cleans private workspaces', async () => {
  const forgedBounds = await fixture({ runner: async ({ stdin }) => {
    const frame = JSON.parse(stdin.toString());
    await writeFile(join(frame.destination, 'duplex-scan.pdf'), PDF, { mode: 0o600, flag: 'wx' });
    return { stdout: `${JSON.stringify(successEnvelope({ pageCount: 4 }))}\n`, stderr: '' };
  } });
  try {
    await assert.rejects(forgedBounds.service.acquire(request()), { code: 'SCANNER_DUPLEX_PROTOCOL_INVALID' });
    assert.deepEqual(await readdir(forgedBounds.root), []);
  } finally { await rm(forgedBounds.root, { recursive: true, force: true }); }
  const forgedDigest = await fixture({ runner: async ({ stdin }) => {
    const frame = JSON.parse(stdin.toString());
    await writeFile(join(frame.destination, 'duplex-scan.pdf'), PDF, { mode: 0o600, flag: 'wx' });
    return { stdout: `${JSON.stringify(successEnvelope({ digest: 'f'.repeat(64) }))}\n`, stderr: '' };
  } });
  try {
    await assert.rejects(forgedDigest.service.acquire(request()), { code: 'SCANNER_DUPLEX_OUTPUT_INVALID' });
  } finally { await rm(forgedDigest.root, { recursive: true, force: true }); }
});

test('duplex service maps cancellation and never invokes a helper for a pre-aborted request', async () => {
  let calls = 0;
  const setup = await fixture({ runner: async () => { calls += 1; throw new Error('must not run'); } });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  try {
    await assert.rejects(setup.service.acquire(request(), { signal: controller.signal }), {
      code: 'JOB_CANCELLED', status: 499,
    });
    assert.equal(calls, 0);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('duplex job maps helper deadline expiry and cleans its private workspace', async () => {
  const setup = await fixture({ runner: async () => {
    throw Object.assign(new Error('deadline'), { code: 'ENGINE_TIMEOUT' });
  } });
  try {
    await assert.rejects(setup.service.acquire(request()), {
      code: 'SCANNER_DUPLEX_TIMEOUT', status: 504,
    });
    assert.deepEqual(await readdir(setup.root), []);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('duplex service rejects a prefix-only PDF when independent structural inspection fails', async () => {
  const malformed = Buffer.from('%PDF-not-a-document', 'ascii');
  const setup = await fixture({
    runner: async ({ stdin }) => {
      const frame = JSON.parse(stdin.toString());
      await writeFile(join(frame.destination, 'duplex-scan.pdf'), malformed, { mode: 0o600, flag: 'wx' });
      return { stdout: `${JSON.stringify(successEnvelope({
        bytes: malformed.length,
        digest: createHash('sha256').update(malformed).digest('hex'),
      }))}\n`, stderr: '' };
    },
    inspection: { inspect: async () => { throw new Error('invalid PDF catalog'); } },
  });
  try {
    await assert.rejects(setup.service.acquire(request()), {
      code: 'SCANNER_DUPLEX_PDF_INVALID', status: 502,
    });
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});
