import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { resolveExecutable } from '../scripts/host/engine-registry.mjs';
import {
  buildQpdfCheckLinearizationArgs,
  buildQpdfLinearizeArgs,
  QpdfAdapter,
} from '../scripts/host/adapters/qpdf.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { PdfFastWebViewService } from '../scripts/host/pdf-fast-web-view-service.mjs';
import {
  normalizePdfFastWebView,
  PDF_FAST_WEB_VIEW_PROFILE,
} from '../scripts/host/pdf-fast-web-view-contract.mjs';

test('qpdf arguments confine output to the private workspace and reject hostile paths', () => {
  const workspace = '/private/jobs/one';
  assert.deepEqual(buildQpdfLinearizeArgs({ input: '/private/docs/source.pdf', output: `${workspace}/linearized.pdf`, workspace }), [
    '--linearize', '/private/docs/source.pdf', `${workspace}/linearized.pdf`,
  ]);
  assert.deepEqual(buildQpdfCheckLinearizationArgs({ input: `${workspace}/linearized.pdf` }), [
    '--check-linearization', `${workspace}/linearized.pdf`,
  ]);
  assert.throws(() => buildQpdfLinearizeArgs({ input: '/private/docs/source.pdf', output: '/private/escape.pdf', workspace }), /inside workspace/);
  assert.throws(() => buildQpdfLinearizeArgs({ input: '/private/docs/source.pdf\0', output: `${workspace}/x.pdf`, workspace }), /without NUL/);
});

test('qpdf adapter rejects inherited operation names before probing or running', async () => {
  let probes = 0; let runs = 0;
  const adapter = new QpdfAdapter({
    registry: { probe: async () => { probes += 1; return { executable: '/engines/qpdf' }; } },
    runner: async () => { runs += 1; },
  });
  for (const operation of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(adapter.execute(operation, {}), /Unknown qpdf operation/);
  }
  await adapter.execute('checkLinearization', { input: '/private/jobs/one/linearized.pdf' });
  assert.equal(probes, 1);
  assert.equal(runs, 1);
});

test('fast-web-view request normalization rejects accessors and extra keys', () => {
  assert.deepEqual(normalizePdfFastWebView({ profile: PDF_FAST_WEB_VIEW_PROFILE }), { profile: PDF_FAST_WEB_VIEW_PROFILE });
  assert.throws(() => normalizePdfFastWebView({ profile: PDF_FAST_WEB_VIEW_PROFILE, extra: true }), { code: 'INVALID_PDF_FAST_WEB_VIEW' });
  const hostile = {};
  Object.defineProperty(hostile, 'profile', { enumerable: true, get() { throw new Error('getter'); } });
  assert.throws(() => normalizePdfFastWebView(hostile), { code: 'INVALID_PDF_FAST_WEB_VIEW' });
});

test('fast-web-view service exposes an explicit unavailable probe and fails closed', async () => {
  const store = {
    getDocument: () => ({ sha256: 'a'.repeat(64), size: 100 }),
    getSourcePath: () => '/private/docs/source.pdf',
    verifySource: async () => {}, createJobWorkspace: async () => '/private/jobs/one',
    cleanupJob: async () => {}, promotePdfArtifact: async () => {}, deleteArtifact: async () => {},
  };
  const qpdf = {
    probe: async () => { const error = new Error('missing'); error.code = 'ENGINE_NOT_FOUND'; throw error; },
    execute: async () => { throw new Error('must not execute'); },
  };
  const service = new PdfFastWebViewService({ store, qpdf });
  assert.deepEqual(await service.probe(), { available: false, name: 'qpdf', version: null, reason: 'ENGINE_NOT_FOUND' });
  await assert.rejects(service.linearize('doc', { profile: PDF_FAST_WEB_VIEW_PROFILE }, { sourceSha256: 'a'.repeat(64) }), { code: 'FAST_WEB_VIEW_UNAVAILABLE' });
});

const qpdfInstalled = await resolveExecutable('qpdf').then(() => true).catch(() => false);
test('installed qpdf linearizes a retained artifact with verified metadata and source preservation', { skip: !qpdfInstalled }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-fast-web-view-live-'));
  const store = await new DocumentStore({ root: join(root, 'store') }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const source = createTextPdf({ text: 'fast web-view live fixture', title: 'Fast Web View' });
  const document = await store.createDocument({ stream: Readable.from([source]), displayName: 'source.pdf' });
  const registry = new EngineRegistry();
  const qpdf = new QpdfAdapter({ registry });
  const service = new PdfFastWebViewService({ store, qpdf });

  const result = await service.linearize(
    document.id,
    { profile: PDF_FAST_WEB_VIEW_PROFILE },
    { sourceSha256: document.sha256 },
  );
  const artifact = store.getArtifact(result.artifact.id);
  const artifactBytes = await readFile(artifact.filePath);
  const prefix = artifactBytes.subarray(0, Math.min(16 * 1024, artifactBytes.length)).toString('latin1');
  const declaredLength = Number(prefix.match(/\/L\s+(\d+)\b/u)?.[1]);
  const endFirstPage = Number(prefix.match(/\/E\s+(\d+)\b/u)?.[1]);

  await qpdf.execute('checkLinearization', { input: artifact.filePath, workspace: root }, { timeoutMs: 30_000 });
  assert.equal((await readFile(store.getSourcePath(document.id))).equals(source), true);
  assert.equal(artifact.size, artifactBytes.length);
  assert.equal(artifact.sha256, createHash('sha256').update(artifactBytes).digest('hex'));
  assert.equal(result.artifact.size, artifact.size);
  assert.equal(result.artifact.sha256, artifact.sha256);
  assert.match(prefix, /\/Linearized\s+1(?:\.0+)?\b/u);
  assert.equal(declaredLength, artifact.size);
  assert.ok(Number.isSafeInteger(endFirstPage) && endFirstPage > 0 && endFirstPage <= artifact.size);
});

function linearizedFixture() {
  const template = '%PDF-1.7\n1 0 obj\n<< /Linearized 1 /L 000000000 /O 1 /E 80 /N 1 /T 80 >>\nendobj\n' + 'x'.repeat(100);
  const bytes = Buffer.from(template.replace('000000000', String(Buffer.byteLength(template)).padStart(9, '0')), 'latin1');
  return bytes;
}

async function cleanupFailureFixture(t, { revokeFails = false, workspaceFails = true } = {}) {
  const root = await mkdtemp('/private/tmp/pdf-fast-web-view-cleanup-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'job');
  const sourceSha256 = 'a'.repeat(64);
  const documentId = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const store = {
    getDocument: () => ({ sha256: sourceSha256, size: 100, displayName: 'source.pdf' }),
    getSourcePath: () => join(root, 'source.pdf'), verifySource: async () => {},
    createJobWorkspace: async () => { await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace)); return workspace; },
    cleanupJob: async () => { calls.push('cleanup'); if (workspaceFails) throw new Error('workspace cleanup failed'); },
    promotePdfArtifact: async () => { calls.push('promote'); return { id: 'artifact-id' }; },
    deleteArtifact: async () => { calls.push('revoke'); if (revokeFails) throw new Error('revoke failed'); },
  };
  const qpdf = {
    probe: async () => ({ name: 'qpdf', version: '11.0.0' }),
    execute: async (operation, parameters) => {
      calls.push(operation);
      if (operation === 'linearize') {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(parameters.output, linearizedFixture(), { mode: 0o600 });
      }
    },
  };
  return { service: new PdfFastWebViewService({ store, qpdf }), sourceSha256, documentId, calls };
}

test('post-promotion workspace cleanup failure revokes the promoted artifact', async (t) => {
  const fixture = await cleanupFailureFixture(t);
  await assert.rejects(
    fixture.service.linearize(fixture.documentId, { profile: PDF_FAST_WEB_VIEW_PROFILE }, { sourceSha256: fixture.sourceSha256 }),
    (error) => error.code === 'PDF_FAST_WEB_VIEW_CLEANUP_FAILED' && fixture.calls.includes('revoke'),
  );
  assert.deepEqual(fixture.calls.filter((call) => call === 'revoke'), ['revoke']);
});

test('successful workspace cleanup preserves the promoted artifact', async (t) => {
  const fixture = await cleanupFailureFixture(t, { workspaceFails: false });
  const result = await fixture.service.linearize(fixture.documentId, { profile: PDF_FAST_WEB_VIEW_PROFILE }, { sourceSha256: fixture.sourceSha256 });
  assert.equal(result.artifact.id, 'artifact-id');
  assert.equal(fixture.calls.includes('revoke'), false);
});

test('post-promotion workspace cleanup and revocation failures are both reported', async (t) => {
  const fixture = await cleanupFailureFixture(t, { revokeFails: true });
  await assert.rejects(
    fixture.service.linearize(fixture.documentId, { profile: PDF_FAST_WEB_VIEW_PROFILE }, { sourceSha256: fixture.sourceSha256 }),
    (error) => error.code === 'PDF_FAST_WEB_VIEW_CLEANUP_FAILED'
      && /workspace or revoke/u.test(error.message)
      && error.cause instanceof AggregateError
      && error.cause.errors.length === 2,
  );
});
