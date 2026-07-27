import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';
import { buildPreflightReport } from '../scripts/host/preflight-rules.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

test('CLI parser exposes strict bounded local commands without arbitrary options', () => {
  assert.deepEqual(parseCliArguments(['inspect', 'local.pdf', '--structure', '--tag-text']), {
    command: 'inspect', input: 'local.pdf', output: null, structure: true, includeTagText: true,
  });
  assert.deepEqual(parseCliArguments(['accessibility-review', 'local.pdf', '--output', 'review.json']), {
    command: 'accessibility-review', input: 'local.pdf', output: 'review.json',
  });
  assert.deepEqual(parseCliArguments(['signature-review', 'local.pdf', '--output', 'review.json']), {
    command: 'signature-review', input: 'local.pdf', output: 'review.json',
  });
  assert.deepEqual(parseCliArguments(['convert-local', 'image.png', '--output', 'image.pdf']), {
    command: 'convert-local', input: 'image.png', output: 'image.pdf',
  });
  assert.deepEqual(parseCliArguments(['compare-content', 'primary.pdf', 'secondary.pdf', '--output', 'report.json']), {
    command: 'compare-content', primaryInput: 'primary.pdf', secondaryInput: 'secondary.pdf', output: 'report.json', format: 'json',
  });
  assert.deepEqual(parseCliArguments(['compare-content', 'primary.pdf', 'secondary.pdf', '--format', 'csv', '--output', 'report.csv']), {
    command: 'compare-content', primaryInput: 'primary.pdf', secondaryInput: 'secondary.pdf', output: 'report.csv', format: 'csv',
  });
  assert.deepEqual(parseCliArguments([
    'ocr-layout', 'scan.pdf', '--page', '2', '--region', '0.1,0.2,0.5,0.3',
    '--cleanup', 'bilevel', '--segmentation', 'block', '--no-tables', '--format', 'html',
  ]), {
    command: 'ocr-layout', input: 'scan.pdf', output: null, format: 'html', page: 2,
    region: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 }, detectTables: false,
    language: 'eng', cleanupPreset: 'bilevel', segmentation: 'block',
  });
  assert.deepEqual(parseCliArguments(['ocr-batch', 'one.pdf', 'two.pdf', '--output-dir', 'results']), {
    command: 'ocr-batch', inputs: ['one.pdf', 'two.pdf'], outputDirectory: 'results',
    language: 'eng', cleanupPreset: 'document', segmentation: 'auto',
  });
  assert.deepEqual(parseCliArguments(['text', 'local.pdf', '--format', 'rtf', '--output', 'export.rtf']), {
    command: 'text', input: 'local.pdf', output: 'export.rtf', format: 'rtf',
  });
  assert.deepEqual(parseCliArguments(['text', 'local.pdf', '--format', 'html', '--output', 'export.html']), {
    command: 'text', input: 'local.pdf', output: 'export.html', format: 'html',
  });
  assert.deepEqual(parseCliArguments(['text', 'local.pdf', '--format', 'xml', '--output', 'export.xml']), {
    command: 'text', input: 'local.pdf', output: 'export.xml', format: 'xml',
  });
  assert.deepEqual(parseCliArguments(['watch-ocr', 'incoming', '--output-dir', 'processed', '--once', '--max-files', '4', '--interval-ms', '500', '--settle-ms', '250']), {
    command: 'watch-ocr', inputDirectory: 'incoming', outputDirectory: 'processed', maxFiles: 4,
    intervalMs: 500, settleMs: 250, once: true,
    language: 'eng', cleanupPreset: 'document', segmentation: 'auto',
  });
  assert.deepEqual(parseCliArguments(['prepress', 'local.pdf', '--operation', 'preflight', '--profile', 'archive-review']), {
    command: 'prepress', input: 'local.pdf', output: null, operation: 'preflight', profile: 'archive-review', format: 'json',
  });
  assert.deepEqual(parseCliArguments(['prepress', 'local.pdf', '--operation', 'preflight', '--format', 'xml']), {
    command: 'prepress', input: 'local.pdf', output: null, operation: 'preflight', profile: 'print-review', format: 'xml',
  });
  assert.deepEqual(parseCliArguments(['prepress', 'local.pdf', '--operation', 'icc-convert', '--output', 'cmyk.pdf']), {
    command: 'prepress', input: 'local.pdf', output: 'cmyk.pdf', operation: 'icc-convert',
  });
  assert.deepEqual(parseCliArguments(['prepress', 'local.pdf', '--operation', 'imposition', '--layout', '2x2', '--output', 'nup.pdf']), {
    command: 'prepress', input: 'local.pdf', output: 'nup.pdf', operation: 'imposition', layout: '2x2',
  });
  assert.deepEqual(parseCliArguments(['prepress', 'local.pdf', '--operation', 'production-validation']), {
    command: 'prepress', input: 'local.pdf', output: null, operation: 'production-validation',
  });
  assert.deepEqual(parseCliArguments(['layer-defaults', 'local.pdf', '--changes', '0:on,1-3:off', '--output', 'layers.pdf']), {
    command: 'layer-defaults', input: 'local.pdf', output: 'layers.pdf',
    changes: [{ groupIndex: 0, visible: true }, { groupIndex: 1, visible: false }, { groupIndex: 2, visible: false }, { groupIndex: 3, visible: false }],
  });
  assert.deepEqual(parseCliArguments(['redact-pages', 'local.pdf', '--pages', '1,3-5', '--output', 'redacted.pdf']), {
    command: 'redact-pages', input: 'local.pdf', pages: [1, 3, 4, 5], output: 'redacted.pdf',
  });
  assert.throws(() => parseCliArguments(['inspect', 'local.pdf', '--tag-text']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['accessibility-review', 'local.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['signature-review', 'local.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['compare-content', 'primary.pdf', 'secondary.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['compare-content', 'primary.pdf', '--output', 'report.json']), { code: 'CLI_INVALID_ARGUMENTS' });
  assert.throws(() => parseCliArguments(['compare-content', 'primary.pdf', 'secondary.pdf', '--format', 'yaml', '--output', 'report.json']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['text', 'local.pdf', '--format', 'rtf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['text', 'local.pdf', '--format', 'html']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['text', 'local.pdf', '--format', 'xml']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['ocr-layout', 'local.pdf', '--format', 'alto']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'ink-coverage', '--dpi', '144']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'preflight', '--dpi', '144']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'separations', '--profile', 'print-review']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'icc-convert']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'icc-convert', '--profile', 'custom', '--output', 'cmyk.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'imposition', '--layout', '3x3', '--output', 'nup.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'production-validation', '--dpi', '144']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'preflight', '--format', 'yaml']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['prepress', 'local.pdf', '--operation', 'separations', '--format', 'xml']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['ocr', 'local.pdf', '--output', 'one.pdf', '--output', 'two.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['ocr-layout', 'local.pdf', '--region', '0.8,0.8,0.3,0.3']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['watch-ocr', 'incoming', '--output-dir', 'processed', '--settle-ms', '10']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['unknown', 'local.pdf']), { code: 'CLI_UNKNOWN_COMMAND' });
  assert.throws(() => parseCliArguments(['ocr-batch', ...Array.from({ length: 9 }, (_, index) => `${index}.pdf`), '--output-dir', 'results']), { code: 'CLI_INVALID_ARGUMENTS' });
  assert.throws(() => parseCliArguments(['layer-defaults', 'local.pdf', '--changes', '2:on,1:off', '--output', 'layers.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['layer-defaults', 'local.pdf', '--changes', '1:on,1:off', '--output', 'layers.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['redact-pages', 'local.pdf', '--pages', '3,1', '--output', 'redacted.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['redact-pages', 'local.pdf', '--pages', '1-101', '--output', 'redacted.pdf']), { code: 'CLI_INVALID_OPTION' });
});

test('CLI prepress artifact operations publish only validated retained PDFs and emit receipts', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-prepress-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const artifactPath = join(directory, 'artifact.pdf');
  const outputPath = join(directory, 'cmyk.pdf');
  await Promise.all([writeFile(input, makeTextPdf('PREPRESS SOURCE')), writeFile(artifactPath, makeTextPdf('PREPRESS DERIVED'))]);
  let disposed = false;
  const fakeApplication = {
    store: {
      async createDocument({ stream, displayName }) {
        let size = 0; for await (const chunk of stream) size += chunk.length;
        return { id: 'document', displayName, size, sha256: 'a'.repeat(64) };
      },
      getArtifact(id) { assert.equal(id, 'artifact'); return { filePath: artifactPath }; },
      async dispose() { disposed = true; },
    },
    prepress: {
      async convertToCmyk(documentId, options) {
        assert.equal(documentId, 'document');
        assert.equal(options.signal, undefined);
        return { kind: 'icc-cmyk-artifact', artifact: { id: 'artifact', sha256: 'b'.repeat(64), displayName: 'input-cmyk.pdf' }, authoritative: false };
      },
    },
  };
  const output = capture();
  await runCli(['prepress', input, '--operation', 'icc-convert', '--output', outputPath], {
    stdout: output.stream, createApplication: async () => fakeApplication,
  });
  const receipt = JSON.parse(output.text());
  assert.equal(receipt.kind, 'icc-cmyk-artifact');
  assert.equal(receipt.artifact.output, 'cmyk.pdf');
  assert.equal(receipt.localOnly, true);
  assert.equal((await readFile(outputPath)).equals(await readFile(artifactPath)), true);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(disposed, true);
});

test('CLI preflight writes deterministic private XML without changing the JSON default', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-preflight-xml-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const xmlOutput = join(directory, 'preflight.xml');
  await writeFile(input, makeTextPdf('PREFLIGHT XML SOURCE'));
  const report = buildPreflightReport({
    profile: 'archive-review',
    document: { sha256: 'a'.repeat(64) },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' },
    structure: {
      pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{
        page: 1, widthPoints: 612, heightPoints: 792,
        boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 } },
      }],
      xmpMetadata: { present: true },
    },
    fonts: [],
    images: [],
  });
  let disposed = false;
  const fakeApplication = {
    store: {
      async createDocument({ stream, displayName }) {
        for await (const _chunk of stream) { /* consume the private upload */ }
        return { id: 'document', displayName, size: 1, sha256: 'a'.repeat(64) };
      },
      async dispose() { disposed = true; },
    },
    prepress: {
      async runPreflight(documentId, options) {
        assert.equal(documentId, 'document');
        assert.deepEqual(options, { profile: 'archive-review', signal: undefined });
        return report;
      },
    },
  };
  const output = capture();
  await runCli([
    'prepress', input, '--operation', 'preflight', '--profile', 'archive-review',
    '--format', 'xml', '--output', xmlOutput,
  ], { stdout: output.stream, createApplication: async () => fakeApplication });
  const xml = await readFile(xmlOutput, 'utf8');
  assert.equal(output.text(), '');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/u);
  assert.match(xml, new RegExp(`report-sha256="${report.reportSha256}"`, 'u'));
  assert.equal((await stat(xmlOutput)).mode & 0o777, 0o600);
  assert.equal(disposed, true);

  const jsonOutput = capture();
  await runCli([
    'prepress', input, '--operation', 'preflight', '--profile', 'archive-review',
  ], { stdout: jsonOutput.stream, createApplication: async () => fakeApplication });
  assert.deepEqual(JSON.parse(jsonOutput.text()), report);
});

test('CLI inspect runs through the private local service and emits no host path', async (context) => {
  try { await access('/opt/homebrew/bin/pdfinfo'); } catch { context.skip('Poppler pdfinfo is not installed in the fixed engine search path.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  await writeFile(input, makeTextPdf('LOCAL CLI INSPECTION'));
  const output = capture();
  await runCli(['inspect', input], { stdout: output.stream });
  const result = JSON.parse(output.text());
  assert.equal(result.source.displayName, 'input.pdf');
  assert.equal(result.inspection.pageCount, 1);
  assert.match(result.source.sha256, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(output.text(), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
});

test('CLI outputs are exclusive and symlink PDF inputs fail closed', async (context) => {
  if (!fsConstants.O_NOFOLLOW) { context.skip('O_NOFOLLOW is unavailable on this platform.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-path-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const linked = join(directory, 'linked.pdf');
  const existingOutput = join(directory, 'existing.json');
  await writeFile(input, makeTextPdf('LOCAL CLI PATHS'));
  await symlink(input, linked);
  await writeFile(existingOutput, 'keep');
  await assert.rejects(runCli(['inspect', linked], { stdout: capture().stream }), { code: 'CLI_INVALID_INPUT' });
  if (await access('/opt/homebrew/bin/pdfinfo').then(() => true, () => false)) {
    await assert.rejects(runCli(['inspect', input, '--output', existingOutput], { stdout: capture().stream }), { code: 'CLI_OUTPUT_EXISTS' });
    assert.equal(await readFile(existingOutput, 'utf8'), 'keep');
  }
});

test('CLI batch OCR is sequential, bounded, manifested, and creates a new private output directory', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-batch-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = [join(directory, 'one.pdf'), join(directory, 'two.pdf')];
  const artifactPath = join(directory, 'artifact.pdf');
  const outputDirectory = join(directory, 'results');
  await Promise.all([...inputs.map((path) => writeFile(path, makeTextPdf('LOCAL BATCH OCR'))), writeFile(artifactPath, makeTextPdf('SEARCHABLE'))]);
  let created = 0;
  let disposed = false;
  let active = 0;
  let maximumActive = 0;
  const fakeApplication = {
    store: {
      async createDocument({ stream, displayName }) {
        let size = 0;
        for await (const chunk of stream) size += chunk.length;
        created += 1;
        return { id: `document-${created}`, displayName, size, sha256: String(created).repeat(64).slice(0, 64) };
      },
      getArtifact(id) { return { id, filePath: artifactPath }; },
      async dispose() { disposed = true; },
    },
    service: {
      async inspect() { return { pageCount: 1 }; },
      async ocrDocument(documentId, options) {
        active += 1; maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          artifact: { id: `artifact-${documentId}`, size: (await stat(artifactPath)).size, sha256: 'a'.repeat(64) },
          result: { recognizedWordCount: 3, suspects: [], language: options.language, cleanupPreset: options.cleanupPreset, segmentation: options.segmentation },
        };
      },
    },
  };
  const output = capture();
  await runCli(['ocr-batch', ...inputs, '--output-dir', outputDirectory], {
    stdout: output.stream, createApplication: async () => fakeApplication,
  });
  const manifest = JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.results.every(({ ok }) => ok), true);
  assert.equal(maximumActive, 1);
  assert.equal(disposed, true);
  assert.equal(JSON.parse(output.text()).complete, true);
  for (const name of ['001-one-searchable-ocr.pdf', '002-two-searchable-ocr.pdf']) {
    const metadata = await stat(join(outputDirectory, name));
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o777, 0o600);
  }
});

test('CLI disposes its private session when cancellation is already requested', async () => {
  let disposed = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCli(['engines'], {
    signal: controller.signal,
    stdout: capture().stream,
    createApplication: async () => ({ store: { async dispose() { disposed = true; } }, service: {} }),
  }), { code: 'JOB_CANCELLED' });
  assert.equal(disposed, true);
});

test('CLI one-shot watch OCR waits for a stable direct child and leaves the source unchanged', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-watch-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const incoming = join(directory, 'incoming');
  const processed = join(directory, 'processed');
  const artifactPath = join(directory, 'artifact.pdf');
  await mkdir(incoming);
  const input = join(incoming, 'drawing.pdf');
  const sourceBytes = makeTextPdf('WATCH OCR SOURCE');
  await Promise.all([writeFile(input, sourceBytes), writeFile(artifactPath, makeTextPdf('WATCH OCR OUTPUT'))]);
  let disposed = false;
  let deleted = 0;
  const fakeApplication = {
    store: {
      async createDocument({ stream, displayName }) {
        let size = 0; for await (const chunk of stream) size += chunk.length;
        return { id: 'watch-document', displayName, size, sha256: 'b'.repeat(64) };
      },
      getArtifact() { return { filePath: artifactPath }; },
      async deleteDocument() { deleted += 1; },
      async dispose() { disposed = true; },
    },
    service: {
      async inspect() { return { pageCount: 1 }; },
      async ocrDocument(_id, options) {
        return {
          artifact: { id: 'watch-artifact', size: (await stat(artifactPath)).size, sha256: 'c'.repeat(64) },
          result: { recognizedWordCount: 2, suspects: [], language: options.language },
        };
      },
    },
  };
  const output = capture();
  await runCli(['watch-ocr', incoming, '--output-dir', processed, '--once', '--settle-ms', '250'], {
    stdout: output.stream, createApplication: async () => fakeApplication,
  });
  const lines = output.text().trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].kind, undefined);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].kind, 'watch-ocr');
  assert.equal(lines[1].complete, true);
  assert.equal((await readFile(input)).equals(sourceBytes), true);
  assert.equal(deleted, 1);
  assert.equal(disposed, true);
  assert.equal((await stat(join(processed, '001-drawing-bbbbbbbbbbbb-searchable-ocr.pdf'))).mode & 0o777, 0o600);
});
