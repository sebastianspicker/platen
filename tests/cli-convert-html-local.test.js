import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';
import { runHtmlConversionCommand } from '../scripts/cli/commands/html-conversion.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';

const assetId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const sourceBytes = Buffer.from('<!doctype html><html><body><p>Hello HTML</p></body></html>');
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(80, 0x4f)]);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');

function command() {
  return { command: 'convert-html-local', input: 'source.html', output: 'output.pdf' };
}

function capture() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    }),
    value: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
}

function fixture({ operation = {}, evidence = {}, writer = null, source = sourceBytes } = {}) {
  const state = { deleted: [], emitted: 0 };
  const asset = Object.freeze({
    id: assetId, displayName: 'source.html', mediaType: 'text/html', kind: 'html', extension: '.html',
    size: source.length, sha256: createHash('sha256').update(source).digest('hex'),
  });
  const provenance = createOperationProvenance({
    type: 'html-to-pdf',
    inputs: [{ assetId, sha256: asset.sha256, role: 'source' }],
    parameters: { sourceFormat: 'html', sourceKind: 'html', conversionMode: 'libreoffice' },
    expected: { minimumPageCount: 1 },
    validation: {
      passed: true,
      validators: ['source-sha256', 'libreoffice-exit-zero', 'pdfinfo-page-count'],
      pageCount: 1,
      ...operation.validation,
    },
  });
  const document = Object.freeze({
    id: documentId,
    origin: 'derived',
    mediaType: 'application/pdf',
    size: pdfBytes.length,
    sha256: pdfSha256,
    operation: provenance,
  });
  const baseEvidence = {
    bytes: pdfBytes,
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' },
    pages: [{ page: 1, widthPoints: 612, heightPoints: 792 }],
    textPages: [{ page: 1, text: 'Hello HTML' }],
  };
  const output = capture();
  return {
    state,
    output,
    application: {
      inputs: {
        async createInput(request) {
          const chunks = [];
          for await (const chunk of request.stream) chunks.push(Buffer.from(chunk));
          assert.deepEqual(Buffer.concat(chunks), source);
          assert.equal(request.mediaType, asset.mediaType);
          return asset;
        },
        async verifyInput(id) { assert.equal(id, assetId); },
      },
      conversion: {
        async convertInput(id) { assert.equal(id, assetId); return document; },
        async prepareHtmlPdfExport(id) {
          assert.equal(id, documentId);
          return { ...baseEvidence, ...evidence };
        },
      },
      store: { async deleteDocument(id) { state.deleted.push(id); } },
    },
    runtime: {
      cancelled() {},
      canonicalOutputTarget: async () => {},
      readLocalInputBytes: async () => ({ bytes: source, displayName: 'source.html' }),
      writeExclusiveVerified: writer ?? (async (_path, bytes, _signal, finalize) => {
        await finalize(Object.freeze({ size: bytes.length, sha256: pdfSha256 }));
      }),
      emit: async (_stream, value) => {
        state.emitted += 1;
        await new Promise((resolve) => output.stream.write(`${JSON.stringify(value)}\n`, resolve));
      },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    },
  };
}

test('convert-html-local parser accepts exactly one HTML input and mandatory PDF output', () => {
  assert.deepEqual(parseCliArguments(['convert-html-local', 'source.html', '--output', 'output.pdf']), command());
  for (const args of [
    ['convert-html-local', 'source.html'],
    ['convert-html-local', 'source.htm', '--output', 'output.pdf'],
    ['convert-html-local', 'source.html', '--output', 'output.txt'],
    ['convert-html-local', 'one.html', 'two.html', '--output', 'output.pdf'],
    ['convert-html-local', 'source.html', '--format', 'pdf', '--output', 'output.pdf'],
  ]) assert.throws(() => parseCliArguments(args), { code: /CLI_INVALID_/u });
});

test('convert-html-local accepts only passive inline HTML and emits a privacy-minimal receipt', async () => {
  const value = fixture();
  await runHtmlConversionCommand(value.application, command(), value.output.stream, undefined, value.runtime);
  const receipt = value.output.value();
  assert.equal(receipt.kind, 'html-to-pdf');
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, pdfSha256);
  assert.equal(receipt.text.aggregateSha256, createHash('sha256').update('Hello HTML').digest('hex'));
  assert.equal(receipt.localOnly, true);
  assert.equal(Object.hasOwn(receipt, 'documentId'), false);
  assert.equal(Object.hasOwn(receipt, 'textPages'), false);
  assert.equal(JSON.stringify(receipt).includes('source.html'), false);
  assert.equal(JSON.stringify(receipt).includes('Hello HTML'), false);
  for (const html of [
    '<html><script>1</script></html>',
    '<html><img src="https://example.test/image.png"></html>',
    '<html><img src="./local.png"></html>',
    '<html><img src="/etc/passwd"></html>',
    '<html><style>body { background: url(local.png) }</style></html>',
    '<html><style>p { background: u\\72l(file:///etc/hosts) }</style></html>',
    '<html><p style="background:image-set(\'file:///etc/hosts\' 1x)">bad</p></html>',
    '<html><base href="file:///tmp/"></html>',
    '<html><meta http-equiv="refresh" content="0; url=local.html"></html>',
    '<html><meta title=">" http-equiv="refresh" content="0;url=file:///etc/hosts"></html>',
    '<!doctype html title=">" PUBLIC "x"><html><p>bad</p></html>',
    '<html><p onclick="alert(1)">bad</p></html>',
    '<html><p title=">" onclick="alert(1)">bad</p></html>',
    '<html><p title=">" style="color:red">bad</p></html>',
    '<html><p title=">" contenteditable>bad</p></html>',
    '<html><form><input name="value"></form></html>',
    '<html><button>Submit</button></html>',
    '<html><select><option>One</option></select></html>',
    '<html><textarea>Editable</textarea></html>',
    '<html><p contenteditable="true">Editable</p></html>',
    '<html><p contenteditable>Editable</p></html>',
  ]) {
    const hostile = fixture({ source: Buffer.from(html) });
    await assert.rejects(
      runHtmlConversionCommand(hostile.application, command(), hostile.output.stream, undefined, hostile.runtime),
      { code: 'HTML_EXTERNAL_CONTENT_FORBIDDEN' },
    );
    assert.deepEqual(hostile.state.deleted, []);
  }
  for (const source of [Buffer.from([0xc3, 0x28]), Buffer.from('<p>bad\0text</p>')]) {
    const hostile = fixture({ source });
    await assert.rejects(
      runHtmlConversionCommand(hostile.application, command(), hostile.output.stream, undefined, hostile.runtime),
      { code: 'HTML_INVALID_ENCODING' },
    );
    assert.deepEqual(hostile.state.deleted, []);
  }
});

test('convert-html-local rejects fallback or forged evidence and revokes validated documents', async () => {
  const fallback = fixture({
    operation: { validation: { validators: ['source-sha256', 'deterministic-text-fallback', 'pdfinfo-page-count'] } },
  });
  await assert.rejects(
    runHtmlConversionCommand(fallback.application, command(), fallback.output.stream, undefined, fallback.runtime),
    { code: 'CLI_INVALID_HTML_CONVERSION' },
  );
  assert.deepEqual(fallback.state.deleted, []);
  const forged = fixture({ evidence: { pages: [{ page: 1, widthPoints: Infinity, heightPoints: 792 }] } });
  await assert.rejects(
    runHtmlConversionCommand(forged.application, command(), forged.output.stream, undefined, forged.runtime),
    { code: 'CLI_INVALID_HTML_CONVERSION' },
  );
  assert.deepEqual(forged.state.deleted, [documentId]);
});

test('convert-html-local revokes on cancellation, publication conflict, receipt mismatch, and cleanup failure', async () => {
  for (const writer of [
    async () => { throw Object.assign(new Error('exists'), { code: 'OUTPUT_EXISTS' }); },
    async (_path, _bytes, _signal, finalize) => finalize(Object.freeze({ size: pdfBytes.length, sha256: '0'.repeat(64) })),
    async (_path, _bytes, _signal, finalize) => {
      await finalize(Object.freeze({ size: pdfBytes.length, sha256: pdfSha256 }));
      throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
    },
  ]) {
    const value = fixture({ writer });
    await assert.rejects(
      runHtmlConversionCommand(value.application, command(), value.output.stream, undefined, value.runtime),
    );
    assert.deepEqual(value.state.deleted, [documentId]);
  }
  const cleanup = fixture({ writer: async () => { throw new Error('publication failed'); } });
  cleanup.application.store.deleteDocument = async () => { throw new Error('cleanup failed'); };
  await assert.rejects(
    runHtmlConversionCommand(cleanup.application, command(), cleanup.output.stream, undefined, cleanup.runtime),
    { code: 'CLI_CONVERSION_CLEANUP_FAILED' },
  );
});

test('installed LibreOffice and Poppler execute the shipped HTML command end to end', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/soffice', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('The fixed LibreOffice and Poppler tools are unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-html-live-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'source.html');
  const outputPath = join(directory, 'output.pdf');
  await writeFile(inputPath, sourceBytes, { mode: 0o600 });
  const output = capture();
  await runCli(['convert-html-local', inputPath, '--output', outputPath], { stdout: output.stream });
  const receipt = output.value();
  const published = await readFile(outputPath);
  assert.equal(receipt.kind, 'html-to-pdf');
  assert.equal(receipt.source.format, 'html');
  assert.equal(receipt.source.sha256, sourceSha256);
  assert.equal(receipt.pdf.sha256, createHash('sha256').update(published).digest('hex'));
  assert.equal(receipt.pdf.pages, 1);
  assert.equal(receipt.text.nonEmptyPages, 1);
  assert.deepEqual(receipt.passiveIndicators, { encrypted: 'no', javascript: 'no', form: 'none' });
  const metadata = await stat(outputPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['output.pdf', 'source.html']);
});
