import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import { ComparisonService } from '../scripts/host/comparison-service.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const documentIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function comparisonApplication({ afterComparison = null, afterExport = null, ids = documentIds } = {}) {
  const documents = new Map();
  const uploads = [];
  let disposed = false;
  const store = {
    async createDocument({ stream, displayName, mediaType }) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const id = ids[uploads.length];
      assert.ok(id, 'comparison uploads must stay bounded to two documents');
      const document = Object.freeze({
        id, displayName, mediaType, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      uploads.push(Object.freeze({ document, bytes }));
      documents.set(id, document);
      return document;
    },
    getDocument(id) {
      const document = documents.get(id);
      assert.ok(document, `comparison requested uploaded document ${id}`);
      return document;
    },
    async verifySource(id) { return documents.has(id); },
    async dispose() { disposed = true; },
  };
  const service = new ComparisonService({
    store,
    pdfService: {
      async inspect() { return { pageCount: 1 }; },
      async extractText(id) { return [{ page: 1, text: id === ids[0] ? 'before words' : 'after words' }]; },
      async renderThumbnail() { throw new Error('content comparison must not render pixels'); },
    },
  });
  const comparisons = {
    async compareContent(...args) {
      const report = await service.compareContent(...args);
      afterComparison?.();
      return report;
    },
    exportContentReport(...args) {
      const exported = service.exportContentReport(...args);
      afterExport?.();
      return exported;
    },
  };
  return {
    application: { store, comparisons },
    uploads: () => uploads,
    disposed: () => disposed,
  };
}

test('CLI content comparison privately writes a fixed two-source JSON report', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-comparison-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const primaryPath = join(directory, 'primary.pdf');
  const secondaryPath = join(directory, 'secondary.pdf');
  const outputPath = join(directory, 'report.json');
  const primary = makeTextPdf('PRIMARY IMMUTABLE SOURCE');
  const secondary = makeTextPdf('SECONDARY IMMUTABLE SOURCE');
  await Promise.all([writeFile(primaryPath, primary), writeFile(secondaryPath, secondary)]);
  const fixture = comparisonApplication();
  const output = capture();

  await runCli(['compare-content', primaryPath, secondaryPath, '--output', outputPath], {
    stdout: output.stream,
    createApplication: async () => fixture.application,
  });

  const report = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(output.text(), '');
  assert.equal(report.kind, 'content');
  assert.equal('documentId' in report.inputs[0], false);
  assert.deepEqual(report.inputs.map(({ role, sha256 }) => ({ role, sha256 })), [
    { role: 'primary', sha256: createHash('sha256').update(primary).digest('hex') },
    { role: 'secondary', sha256: createHash('sha256').update(secondary).digest('hex') },
  ]);
  assert.equal(fixture.uploads().length, 2);
  assert.deepEqual(fixture.uploads().map(({ document }) => document.mediaType), ['application/pdf', 'application/pdf']);
  assert.deepEqual(fixture.uploads().map(({ bytes }) => bytes), [primary, secondary]);
  assert.deepEqual(await Promise.all([readFile(primaryPath), readFile(secondaryPath)]), [primary, secondary]);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(fixture.disposed(), true);
});

test('CLI content comparison cancellation during publication leaves no output or partial', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-comparison-publish-cancel-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const primaryPath = join(directory, 'primary.pdf');
  const secondaryPath = join(directory, 'secondary.pdf');
  const outputPath = join(directory, 'cancelled.json');
  await Promise.all([writeFile(primaryPath, makeTextPdf('PRIMARY')), writeFile(secondaryPath, makeTextPdf('SECONDARY'))]);
  const controller = new AbortController();
  const fixture = comparisonApplication({
    afterExport: () => queueMicrotask(() => controller.abort()),
  });

  await assert.rejects(runCli(['compare-content', primaryPath, secondaryPath, '--output', outputPath], {
    stdout: capture().stream,
    createApplication: async () => fixture.application,
    signal: controller.signal,
  }), { code: 'JOB_CANCELLED' });

  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.partial')), false);
  assert.equal(fixture.disposed(), true);
});

test('CLI content comparison JSON is deterministic across private sessions', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-comparison-determinism-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const primaryPath = join(directory, 'primary.pdf');
  const secondaryPath = join(directory, 'secondary.pdf');
  const firstOutput = join(directory, 'first.json');
  const secondOutput = join(directory, 'second.json');
  await Promise.all([writeFile(primaryPath, makeTextPdf('PRIMARY')), writeFile(secondaryPath, makeTextPdf('SECONDARY'))]);
  const alternateIds = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const first = comparisonApplication();
  const second = comparisonApplication({ ids: alternateIds });

  await runCli(['compare-content', primaryPath, secondaryPath, '--output', firstOutput], { createApplication: async () => first.application });
  await runCli(['compare-content', primaryPath, secondaryPath, '--output', secondOutput], { createApplication: async () => second.application });

  assert.equal(await readFile(firstOutput, 'utf8'), await readFile(secondOutput, 'utf8'));
  assert.equal(first.disposed(), true);
  assert.equal(second.disposed(), true);
});

test('CLI content comparison privately writes source-bound formula-safe CSV', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-comparison-csv-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const primaryPath = join(directory, 'primary.pdf');
  const secondaryPath = join(directory, 'secondary.pdf');
  const outputPath = join(directory, 'report.csv');
  const primary = makeTextPdf('PRIMARY CSV SOURCE');
  const secondary = makeTextPdf('SECONDARY CSV SOURCE');
  await Promise.all([writeFile(primaryPath, primary), writeFile(secondaryPath, secondary)]);
  const fixture = comparisonApplication();
  const output = capture();

  await runCli(['compare-content', primaryPath, secondaryPath, '--format', 'csv', '--output', outputPath], {
    stdout: output.stream,
    createApplication: async () => fixture.application,
  });

  const csv = await readFile(outputPath, 'utf8');
  assert.equal(output.text(), '');
  assert.match(csv, /^"primarySha256","secondarySha256","kind","page","status","added","deleted","unchanged"/u);
  assert.match(csv, new RegExp(createHash('sha256').update(primary).digest('hex'), 'u'));
  assert.match(csv, new RegExp(createHash('sha256').update(secondary).digest('hex'), 'u'));
  assert.doesNotMatch(csv, /documentId/u);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(await Promise.all([readFile(primaryPath), readFile(secondaryPath)]), [primary, secondary]);
  assert.equal(fixture.disposed(), true);
});

test('CLI content comparison cancellation after comparison publishes no output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-comparison-cancel-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const primaryPath = join(directory, 'primary.pdf');
  const secondaryPath = join(directory, 'secondary.pdf');
  const outputPath = join(directory, 'cancelled.json');
  await Promise.all([writeFile(primaryPath, makeTextPdf('PRIMARY')), writeFile(secondaryPath, makeTextPdf('SECONDARY'))]);
  const controller = new AbortController();
  const fixture = comparisonApplication({ afterComparison: () => controller.abort() });
  const output = capture();

  await assert.rejects(runCli(['compare-content', primaryPath, secondaryPath, '--output', outputPath], {
    stdout: output.stream,
    createApplication: async () => fixture.application,
    signal: controller.signal,
  }), { code: 'JOB_CANCELLED' });

  assert.equal(fixture.uploads().length, 2);
  assert.equal(output.text(), '');
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(fixture.disposed(), true);
});
