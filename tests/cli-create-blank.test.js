import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';

const execFileAsync = promisify(execFile);
const documentId = '11111111-1111-4111-8111-111111111111';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function operation(pages, overrides = {}) {
  return createOperationProvenance({
    type: 'create-blank-pdf',
    inputs: [],
    parameters: {
      pages,
      widthPoints: 612,
      heightPoints: 792,
      title: 'Untitled',
      ...(overrides.parameters ?? {}),
    },
    expected: { pageCount: pages, ...(overrides.expected ?? {}) },
    validation: {
      passed: true,
      validators: ['local-pdf-factory'],
      pageCount: pages,
      ...(overrides.validation ?? {}),
    },
  });
}

async function fakeApplication(directory, {
  pages = 2,
  abortController = null,
  recordOverrides = {},
  operationOverrides = {},
  inspectionOverrides = {},
  pageOverrides = {},
  text = '',
} = {}) {
  const bytes = createBlankPdf({ pages, widthPoints: 612, heightPoints: 792, title: 'Untitled' });
  const record = {
    id: documentId,
    displayName: 'untitled.pdf',
    mediaType: 'application/pdf',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    origin: 'derived',
    operation: operation(pages, operationOverrides),
    ...recordOverrides,
  };
  const state = { createCalls: 0, prepareCalls: 0, disposed: false };
  return {
    bytes,
    state,
    application: {
      conversion: {
        async createBlank(options) {
          state.createCalls += 1;
          assert.deepEqual(options, {
            pages, widthPoints: 612, heightPoints: 792, title: 'Untitled',
          });
          abortController?.abort();
          return record;
        },
        async prepareBlankExport(id, options) {
          state.prepareCalls += 1;
          assert.equal(id, documentId);
          assert.equal(options.pages, pages);
          return {
            bytes: Buffer.from(bytes),
            inspection: {
              pageCount: pages,
              title: 'Untitled',
              encrypted: 'no',
              javascript: 'no',
              form: 'none',
              ...inspectionOverrides,
            },
            pageOne: {
              page: 1,
              widthPoints: 612,
              heightPoints: 792,
              ...pageOverrides,
            },
            textPages: Array.from({ length: pages }, (_, index) => ({
              page: index + 1,
              text: index === 0 ? text : '',
            })),
          };
        },
      },
      store: {
        async dispose() { state.disposed = true; },
      },
    },
  };
}

test('create-blank parser accepts only a bounded page count and mandatory output', () => {
  assert.deepEqual(parseCliArguments(['create-blank', '--output', 'blank.pdf']), {
    command: 'create-blank', pages: 1, output: 'blank.pdf',
  });
  assert.deepEqual(parseCliArguments([
    'create-blank', '--pages', '500', '--output', 'blank.pdf',
  ]), { command: 'create-blank', pages: 500, output: 'blank.pdf' });
  assert.throws(
    () => parseCliArguments(['create-blank', 'input.pdf', '--output', 'blank.pdf']),
    { code: 'CLI_INVALID_ARGUMENTS' },
  );
  for (const arguments_ of [
    ['create-blank'],
    ['create-blank', '--pages', '0', '--output', 'blank.pdf'],
    ['create-blank', '--pages', '501', '--output', 'blank.pdf'],
    ['create-blank', '--pages', '1.5', '--output', 'blank.pdf'],
    ['create-blank', '--pages', '+1', '--output', 'blank.pdf'],
    ['create-blank', '--pages', '01', '--output', 'blank.pdf'],
    ['create-blank', '--title', 'Other', '--output', 'blank.pdf'],
  ]) assert.throws(() => parseCliArguments(arguments_), { code: 'CLI_INVALID_OPTION' });
});

test('create-blank writes deterministic private bytes and a sanitized receipt', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-blank-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'created.pdf');
  const fixture = await fakeApplication(directory);
  const output = capture();
  await runCli(['create-blank', '--pages', '2', '--output', outputPath], {
    stdout: output.stream,
    createApplication: async () => fixture.application,
  });
  const bytes = await readFile(outputPath);
  const receipt = JSON.parse(output.text());
  assert.equal(bytes.equals(fixture.bytes), true);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(receipt.kind, 'blank-pdf');
  assert.equal(receipt.output, basename(outputPath));
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(receipt.pageSize, { widthPoints: 612, heightPoints: 792 });
  assert.deepEqual(receipt.validation.popplerIndicators, {
    encrypted: 'no', javascript: 'no', form: 'none',
  });
  assert.equal(Object.hasOwn(receipt.validation, 'passive'), false);
  assert.equal(receipt.validation.sourceIntegrity, 'descriptor-bound-sha256');
  assert.equal(receipt.validation.textEmpty, true);
  assert.doesNotMatch(output.text(), new RegExp(directory));
  assert.doesNotMatch(output.text(), new RegExp(documentId));
  assert.equal(fixture.state.disposed, true);

  const second = await fakeApplication(directory);
  await assert.rejects(runCli([
    'create-blank', '--pages', '2', '--output', outputPath,
  ], {
    stdout: capture().stream,
    createApplication: async () => second.application,
  }), { code: 'CLI_OUTPUT_EXISTS' });
  assert.equal((await readFile(outputPath)).equals(bytes), true);
  assert.equal(second.state.createCalls, 0);
  assert.equal(second.state.prepareCalls, 0);
  assert.equal(second.state.disposed, true);
});

test('create-blank keeps a committed output when cancellation arrives during receipt delivery', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-blank-commit-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const fixture = await fakeApplication(directory);
  const outputPath = join(directory, 'committed.pdf');
  const receipt = new Writable({
    write(_chunk, _encoding, callback) {
      controller.abort(new Error('late cancellation'));
      callback();
    },
  });
  await runCli(['create-blank', '--pages', '2', '--output', outputPath], {
    signal: controller.signal,
    stdout: receipt,
    createApplication: async () => fixture.application,
  });
  assert.equal((await readFile(outputPath)).equals(fixture.bytes), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(fixture.state.disposed, true);
});

test('create-blank sanitizes output filesystem errors', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-blank-private-'));
  const privateParent = join(directory, 'caller-secret-parent');
  await mkdir(privateParent, { mode: 0o700 });
  context.after(async () => {
    await chmod(privateParent, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await chmod(privateParent, 0o500);
  const fixture = await fakeApplication(directory);
  const outputPath = join(privateParent, 'created.pdf');
  const error = await runCli(['create-blank', '--pages', '2', '--output', outputPath], {
    stdout: capture().stream,
    createApplication: async () => fixture.application,
  }).then(() => null, (caught) => caught);
  assert.equal(error?.code, 'CLI_OUTPUT_FAILED');
  assert.equal(error?.message, 'The output could not be published to the requested local path.');
  assert.doesNotMatch(error.message, new RegExp(directory));
  assert.doesNotMatch(error.message, /\.platen-/u);
  assert.equal(fixture.state.disposed, true);
});

test('create-blank rejects cancellation and malformed validation evidence without output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-blank-reject-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const cancelledFixture = await fakeApplication(directory, { abortController: controller });
  const cancelledOutput = join(directory, 'cancelled.pdf');
  await assert.rejects(runCli(['create-blank', '--pages', '2', '--output', cancelledOutput], {
    signal: controller.signal,
    stdout: capture().stream,
    createApplication: async () => cancelledFixture.application,
  }), { code: 'JOB_CANCELLED' });
  await assert.rejects(access(cancelledOutput));
  assert.equal(cancelledFixture.state.disposed, true);

  const cases = [
    { name: 'provenance', options: { operationOverrides: { parameters: { pages: 3 } } } },
    { name: 'size', options: { recordOverrides: { size: 999_999 } } },
    { name: 'digest', options: { recordOverrides: { sha256: 'f'.repeat(64) } } },
    { name: 'page-count', options: { inspectionOverrides: { pageCount: 1 } } },
    { name: 'geometry', options: { pageOverrides: { widthPoints: 611 } } },
    { name: 'active-state', options: { inspectionOverrides: { javascript: 'yes' } } },
    { name: 'text', options: { text: 'not blank' } },
  ];
  for (const scenario of cases) {
    const fixture = await fakeApplication(directory, scenario.options);
    const outputPath = join(directory, `${scenario.name}.pdf`);
    await assert.rejects(runCli([
      'create-blank', '--pages', '2', '--output', outputPath,
    ], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
    }), { code: 'CLI_INVALID_CREATED_PDF' });
    await assert.rejects(access(outputPath));
    assert.equal(fixture.state.disposed, true);
  }
});

test('installed Poppler validates a created blank PDF end to end', async (context) => {
  try {
    await Promise.all([
      '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext',
    ].map((path) => access(path)));
  } catch {
    context.skip('The fixed Poppler inspection tools are unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-blank-poppler-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'blank.pdf');
  const output = capture();
  await runCli(['create-blank', '--pages', '3', '--output', outputPath], {
    stdout: output.stream,
  });
  const [{ stdout: info }, { stdout: text }] = await Promise.all([
    execFileAsync('/opt/homebrew/bin/pdfinfo', [outputPath]),
    execFileAsync('/opt/homebrew/bin/pdftotext', [outputPath, '-']),
  ]);
  assert.match(info, /^Pages:\s+3$/mu);
  assert.match(info, /^Page size:\s+612 x 792 pts/mu);
  assert.match(info, /^Encrypted:\s+no$/mu);
  assert.match(info, /^JavaScript:\s+no$/mu);
  assert.match(info, /^Form:\s+none$/mu);
  assert.equal(text.trim(), '');
  const receipt = JSON.parse(output.text());
  assert.equal(receipt.pages, 3);
  assert.equal(receipt.size, (await stat(outputPath)).size);
});
