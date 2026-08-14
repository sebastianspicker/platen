import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';
import { runConversionCommand } from '../scripts/cli/commands/conversion.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { decodePng, encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';

const assetId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
function capture() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}
function sourcePng() {
  return encodeRgbaPng({
    width: 2,
    height: 3,
    pixels: Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
      255, 0, 255, 255, 0, 255, 255, 255,
    ]),
  });
}
function fakeApplication(sourceBytes, {
  abortController = null,
  deleteDocumentError = null,
  documentOverrides = {},
  operationOverrides = {},
  inspectionOverrides = {},
  pageOverrides = {},
  text = '',
  images = null,
} = {}) {
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const decoded = decodePng(sourceBytes);
  const normalized = encodeRgbaPng(decoded);
  const normalizedSha256 = createHash('sha256').update(normalized).digest('hex');
  const pdfBytes = createBlankPdf({ title: 'Converted image' });
  const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
  const state = {
    createdInputs: 0,
    conversionCalls: 0,
    exportCalls: 0,
    deletedDocuments: [],
    disposed: false,
  };
  const asset = Object.freeze({
    id: assetId,
    displayName: 'source.png',
    mediaType: 'image/png',
    kind: 'image',
    extension: '.png',
    size: sourceBytes.length,
    sha256: sourceSha256,
  });
  const operation = createOperationProvenance({
    type: 'image-to-pdf',
    inputs: [{ assetId, sha256: sourceSha256, role: 'source' }],
    parameters: {
      sourceFormat: 'png', sourceKind: 'image',
      sourceWidthPixels: decoded.width,
      sourceHeightPixels: decoded.height,
      normalizedSha256,
      ...(operationOverrides.parameters ?? {}),
    },
    expected: { minimumPageCount: 1, ...(operationOverrides.expected ?? {}) },
    validation: {
      passed: true,
      validators: ['source-sha256', 'imagemagick-exit-zero', 'pdfinfo-page-count'],
      pageCount: 1,
      ...(operationOverrides.validation ?? {}),
    },
  });
  const document = {
    id: documentId,
    displayName: 'source.pdf',
    mediaType: 'application/pdf',
    origin: 'derived',
    size: pdfBytes.length,
    sha256: pdfSha256,
    operation,
    ...documentOverrides,
  };
  return {
    pdfBytes,
    state,
    application: {
      inputs: {
        async createInput({ stream, displayName, mediaType }) {
          state.createdInputs += 1;
          const chunks = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          assert.equal(Buffer.concat(chunks).equals(sourceBytes), true);
          assert.equal(displayName, 'source.png');
          assert.equal(mediaType, 'image/png');
          return asset;
        },
        async verifyInput(id) { assert.equal(id, assetId); return true; },
      },
      conversion: {
        async convertInput(id, { signal }) {
          state.conversionCalls += 1;
          assert.equal(id, assetId);
          assert.equal(signal instanceof AbortSignal || signal === undefined, true);
          abortController?.abort();
          return document;
        },
        async preparePngPdfExport(id) {
          state.exportCalls += 1;
          assert.equal(id, documentId);
          return {
            bytes: Buffer.from(pdfBytes),
            inspection: {
              pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none',
              ...inspectionOverrides,
            },
            pageOne: {
              page: 1, widthPoints: 2, heightPoints: 3, ...pageOverrides,
            },
            textPages: [{ page: 1, text }],
            images: images ?? [{
              page: 1, number: 0, type: 'image', width: 2, height: 3,
              color: 'rgb', bitsPerComponent: 8,
            }],
          };
        },
      },
      store: {
        async deleteDocument(id) {
          state.deletedDocuments.push(id);
          if (deleteDocumentError) throw deleteDocumentError;
        },
        async dispose() { state.disposed = true; },
      },
    },
  };
}
test('convert-local parser exposes only one mandatory-output PNG input', () => {
  assert.deepEqual(parseCliArguments([
    'convert-local', 'source.PNG', '--output', 'output.pdf',
  ]), { command: 'convert-local', input: 'source.PNG', output: 'output.pdf' });
  for (const arguments_ of [
    ['convert-local', 'source.png'],
    ['convert-local', 'source.jpg', '--output', 'output.pdf'],
    ['convert-local', 'source.png', '--output', 'output.txt'],
    ['convert-local', 'source.png', '--format', 'pdf', '--output', 'output.pdf'],
  ]) assert.throws(() => parseCliArguments(arguments_), { code: 'CLI_INVALID_OPTION' });
  assert.throws(
    () => parseCliArguments(['convert-local', 'one.png', 'two.png', '--output', 'output.pdf']),
    { code: 'CLI_INVALID_ARGUMENTS' },
  );
});
function directConversionRuntime(sourceBytes, fixture, {
  abortController = null,
  abortAfterWrite = false,
  emitError = null,
  publishOutput = false,
  receipt = Object.freeze({ size: fixture.pdfBytes.length, sha256: createHash('sha256').update(fixture.pdfBytes).digest('hex') }),
} = {}) {
  const calls = [];
  const emitted = [];
  return {
    calls,
    emitted,
    canonicalOutputTarget: async (output) => { calls.push(['target', output]); },
    readLocalInputBytes: async () => ({ bytes: Buffer.from(sourceBytes), displayName: 'source.png' }),
    cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('The local CLI operation was cancelled.'), { code: 'JOB_CANCELLED' }); },
    async writeExclusiveVerified(output, bytes, signal, finalize) {
      calls.push(['writeExclusiveVerified', output, Buffer.from(bytes), signal]);
      let published = false;
      try {
        if (publishOutput) {
          await writeFile(output, bytes, { mode: 0o600 });
          published = true;
        }
        if (abortAfterWrite) abortController?.abort();
        await finalize(receipt);
        return receipt;
      } catch (error) {
        if (published) await rm(output, { force: true });
        throw error;
      }
    },
    async emit(_stdout, value) { if (emitError) throw emitError; emitted.push(value); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
}
test('convert-local verifies the immutable publication receipt before emitting', async () => {
  const sourceBytes = sourcePng();
  const fixture = fakeApplication(sourceBytes);
  const runtime = directConversionRuntime(sourceBytes, fixture);
  await runConversionCommand(
    fixture.application,
    { input: 'source.png', output: 'output.pdf' },
    capture().stream,
    undefined,
    runtime,
  );
  assert.equal(runtime.calls[1][0], 'writeExclusiveVerified');
  assert.equal(runtime.calls[1][2].equals(fixture.pdfBytes), true);
  assert.equal(runtime.emitted.length, 1);
  assert.deepEqual(fixture.state.deletedDocuments, []);
});
test('convert-local revokes the exact derived document on receipt mismatch or cancellation', async (context) => {
  const sourceBytes = sourcePng();
  const mismatch = fakeApplication(sourceBytes);
  const mismatchRuntime = directConversionRuntime(sourceBytes, mismatch, {
    receipt: Object.freeze({ size: 1, sha256: '0'.repeat(64) }),
  });
  await assert.rejects(runConversionCommand(
    mismatch.application,
    { input: 'source.png', output: 'mismatch.pdf' },
    capture().stream,
    undefined,
    mismatchRuntime,
  ), { code: 'CLI_INVALID_CONVERTED_PDF' });
  assert.deepEqual(mismatch.state.deletedDocuments, [documentId]);
  assert.equal(mismatchRuntime.emitted.length, 0);
  const controller = new AbortController();
  const cancellation = fakeApplication(sourceBytes);
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-convert-cancel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cancelledPath = join(directory, 'cancelled.pdf');
  const cancellationRuntime = directConversionRuntime(sourceBytes, cancellation, {
    abortController: controller,
    abortAfterWrite: true,
    publishOutput: true,
  });
  await assert.rejects(runConversionCommand(
    cancellation.application,
    { input: 'source.png', output: cancelledPath },
    capture().stream,
    controller.signal,
    cancellationRuntime,
  ), { code: 'JOB_CANCELLED' });
  await assert.rejects(access(cancelledPath));
  assert.deepEqual(cancellation.state.deletedDocuments, [documentId]);
  assert.equal(cancellationRuntime.emitted.length, 0);
});
test('convert-local revokes after postflight emit failure and reports cleanup failure safely', async (context) => {
  const sourceBytes = sourcePng();
  const primaryError = Object.assign(new Error('postflight failed'), { code: 'POSTFLIGHT_FAILED' });
  const cleanupError = Object.assign(new Error('revoke failed'), { code: 'REVOKE_FAILED' });
  const fixture = fakeApplication(sourceBytes, {
    deleteDocumentError: cleanupError,
  });
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-convert-postflight-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'postflight.pdf');
  const runtime = directConversionRuntime(sourceBytes, fixture, {
    emitError: primaryError, publishOutput: true,
  });
  await assert.rejects(runConversionCommand(
    fixture.application,
    { input: 'source.png', output: outputPath },
    capture().stream,
    undefined,
    runtime,
  ), (error) => {
    assert.equal(error.code, 'CLI_CONVERSION_CLEANUP_FAILED');
    assert.equal(error.cause instanceof AggregateError, true);
    assert.equal(error.cause.errors[0], primaryError);
    assert.equal(error.cause.errors[1], cleanupError);
    assert.doesNotMatch(error.message, new RegExp(documentId));
    return true;
  });
  await assert.rejects(access(outputPath));
  assert.deepEqual(fixture.state.deletedDocuments, [documentId]);
  assert.equal(runtime.emitted.length, 0);
});
test('convert-local publishes one verified private PDF and a bounded receipt', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-convert-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.png');
  const outputPath = join(directory, 'converted.pdf');
  const sourceBytes = sourcePng();
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const fixture = fakeApplication(sourceBytes);
  const output = capture();
  await runCli(['convert-local', sourcePath, '--output', outputPath], {
    stdout: output.stream,
    createApplication: async () => fixture.application,
  });
  const published = await readFile(outputPath);
  const receipt = JSON.parse(output.text());
  assert.equal(published.equals(fixture.pdfBytes), true);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(receipt.kind, 'png-to-pdf');
  assert.equal(receipt.output, basename(outputPath));
  assert.deepEqual(receipt.source.width, 2);
  assert.deepEqual(receipt.source.height, 3);
  assert.equal(receipt.source.sha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(receipt.pdf.sha256, createHash('sha256').update(published).digest('hex'));
  assert.equal(receipt.validation.primaryImageDimensionsMatch, true);
  assert.doesNotMatch(output.text(), new RegExp(directory));
  assert.doesNotMatch(output.text(), new RegExp(`${assetId}|${documentId}`));
  assert.equal(fixture.state.disposed, true);

  const second = fakeApplication(sourceBytes);
  await assert.rejects(runCli(['convert-local', sourcePath, '--output', outputPath], {
    stdout: capture().stream,
    createApplication: async () => second.application,
  }), { code: 'CLI_OUTPUT_EXISTS' });
  assert.equal(second.state.createdInputs, 0);
  assert.equal(second.state.disposed, true);
});
test('convert-local rejects symlinks, hard links, cancellation, and mismatched evidence without output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-convert-reject-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourceBytes = sourcePng();
  const sourcePath = join(directory, 'source.png');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  for (const [name, makeLinked] of [
    ['symbolic', (path) => symlink(sourcePath, path)],
    ['hard', (path) => link(sourcePath, path)],
  ]) {
    const linkedPath = join(directory, `${name}.png`);
    await makeLinked(linkedPath);
    const fixture = fakeApplication(sourceBytes);
    await assert.rejects(runCli([
      'convert-local', linkedPath, '--output', join(directory, `${name}.pdf`),
    ], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
    }), { code: 'CLI_INVALID_INPUT' });
    assert.equal(fixture.state.createdInputs, 0);
    assert.equal(fixture.state.disposed, true);
    await rm(linkedPath);
  }
  const controller = new AbortController();
  const cancelled = fakeApplication(sourceBytes, { abortController: controller });
  const cancelledOutput = join(directory, 'cancelled.pdf');
  await assert.rejects(runCli([
    'convert-local', sourcePath, '--output', cancelledOutput,
  ], {
    signal: controller.signal,
    stdout: capture().stream,
    createApplication: async () => cancelled.application,
  }), { code: 'JOB_CANCELLED' });
  await assert.rejects(access(cancelledOutput));

  const cases = [
    { name: 'provenance', options: { operationOverrides: { parameters: { sourceWidthPixels: 4 } } } },
    { name: 'page-count', options: { inspectionOverrides: { pageCount: 2 } } },
    { name: 'active', options: { inspectionOverrides: { javascript: 'yes' } } },
    { name: 'geometry', options: { pageOverrides: { widthPoints: 0 } } },
    { name: 'text', options: { text: 'unexpected text' } },
    { name: 'image', options: { images: [{ page: 1, number: 0, type: 'image', width: 3, height: 3, color: 'rgb', bitsPerComponent: 8 }] } },
  ];
  for (const scenario of cases) {
    const fixture = fakeApplication(sourceBytes, scenario.options);
    const outputPath = join(directory, `${scenario.name}.pdf`);
    await assert.rejects(runCli([
      'convert-local', sourcePath, '--output', outputPath,
    ], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
    }), { code: 'CLI_INVALID_CONVERTED_PDF' });
    await assert.rejects(access(outputPath));
    assert.equal(fixture.state.disposed, true);
  }
});
test('installed ImageMagick and Poppler convert a strict PNG end to end', async (context) => {
  try {
    await Promise.all([
      '/opt/homebrew/bin/magick', '/opt/homebrew/bin/pdfinfo',
      '/opt/homebrew/bin/pdfimages', '/opt/homebrew/bin/pdftotext',
    ].map((path) => access(path)));
  } catch {
    context.skip('The fixed ImageMagick and Poppler tools are unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-convert-live-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.png');
  const outputPath = join(directory, 'converted.pdf');
  await writeFile(sourcePath, sourcePng(), { mode: 0o600 });
  const output = capture();
  await runCli(['convert-local', sourcePath, '--output', outputPath], {
    stdout: output.stream,
  });
  const receipt = JSON.parse(output.text());
  assert.equal(receipt.source.width, 2);
  assert.equal(receipt.source.height, 3);
  assert.equal(receipt.pdf.pages, 1);
  assert.equal(receipt.validation.primaryImageDimensionsMatch, true);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});
