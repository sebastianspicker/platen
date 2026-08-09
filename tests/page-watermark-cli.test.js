import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePageWatermark } from '../scripts/cli/parser-page-watermark.mjs';
import { runPageWatermarkCommand } from '../scripts/cli/commands/page-watermark.mjs';

const sourceSha256 = 'a'.repeat(64);

function parse(args = {}) {
  return parsePageWatermark(
    'page-watermark',
    [args.input ?? 'input.pdf'],
    new Map([
      ['pages', args.pages ?? '1,3-4'],
      ['text', args.text ?? 'CONFIDENTIAL'],
    ]),
    args.output ?? '/tmp/output.pdf',
  );
}

test('page-watermark parser accepts one bounded PDF input and normalizes page ranges', () => {
  const command = parse();
  assert.deepEqual(command.pages, [1, 3, 4]);
  assert.equal(command.text, 'CONFIDENTIAL');
  assert.equal(command.output, '/tmp/output.pdf');
  assert.ok(Object.isFrozen(command));
});

test('page-watermark parser rejects hostile input, pages, text, and output values', () => {
  const hostile = [
    { input: 'input.txt' },
    { input: 'one.pdf', output: '/tmp/output.pdf', pages: '1,1' },
    { pages: '2,1' },
    { pages: '1-501' },
    { pages: '1,,2' },
    { text: '' },
    { text: 'e\u0301' },
    { text: 'line\nfeed' },
    { text: 'é' },
    { text: 'x'.repeat(81) },
    { output: '/tmp/output.txt' },
  ];
  for (const value of hostile) {
    assert.throws(() => parse(value), { code: 'CLI_INVALID_OPTION' });
  }
  assert.throws(() => parsePageWatermark('page-watermark', ['one.pdf', 'two.pdf'], new Map([
    ['pages', '1'], ['text', 'OK'],
  ]), '/tmp/output.pdf'), { code: 'CLI_INVALID_ARGUMENTS' });
});

function runtimeWith({ emit, copyExclusive, cancelled = () => {}, canonicalOutputTarget = async () => {} } = {}) {
  return {
    cancelled,
    canonicalOutputTarget,
    copyExclusive: copyExclusive ?? (async () => {}),
    emit: emit ?? (async () => {}),
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
}

test('page-watermark command sends source-bound request and emits a privacy-safe receipt', async () => {
  const calls = [];
  const emitted = [];
  const artifact = {
    id: 'artifact-1',
    documentId: 'document-1',
    displayName: 'page-watermarked.pdf',
    mediaType: 'application/pdf',
    size: 100,
    sha256: 'b'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    filePath: '/private/workspace/output.pdf',
  };
  const result = {
    kind: 'pdf-page-watermark',
    artifact: { ...artifact, sourceSha256, text: 'CONFIDENTIAL', pdf: Buffer.from('%PDF') },
    pages: [{ page: 1, applied: true, text: 'CONFIDENTIAL' }],
    evidence: { sourceDigestReverified: true, localOnly: true, privatePath: '/private/workspace' },
    sourceSha256,
    text: 'CONFIDENTIAL',
  };
  const application = {
    pageWatermark: {
      async create(...args) { calls.push(args); return result; },
    },
    store: {
      getArtifact(id) { assert.equal(id, artifact.id); return artifact; },
      async deleteArtifact() { assert.fail('successful command must not delete retained artifact'); },
    },
  };
  const command = { command: 'page-watermark', output: '/tmp/output.pdf', pages: [1], text: 'CONFIDENTIAL' };
  await runPageWatermarkCommand(application, command, { id: 'document-1', sha256: sourceSha256 }, {}, undefined,
    runtimeWith({ emit: async (_stdout, value) => emitted.push(value) }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], {
    profile: 'local-pdf-page-watermark-v1', sourceSha256, pages: [1], text: 'CONFIDENTIAL',
  });
  assert.equal(calls[0][2].sourceSha256, sourceSha256);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].artifact.output, 'output.pdf');
  const receipt = JSON.stringify(emitted[0]);
  assert.doesNotMatch(receipt, /private\/workspace|CONFIDENTIAL|sourceSha256|rawPdf|%PDF/u);
  assert.equal(Object.hasOwn(emitted[0].artifact, 'filePath'), false);
  assert.deepEqual(emitted[0].pages, [{ page: 1, applied: true }]);
});

test('page-watermark command revokes retained artifact when publication fails', async () => {
  const deleted = [];
  const result = { artifact: { id: 'artifact-2' } };
  const application = {
    pageWatermark: { async create() { return result; } },
    store: {
      getArtifact() { return { filePath: '/private/output.pdf' }; },
      async deleteArtifact(id) { deleted.push(id); },
    },
  };
  await assert.rejects(
    runPageWatermarkCommand(application, {
      command: 'page-watermark', output: '/tmp/output.pdf', pages: [1], text: 'OK',
    }, { id: 'document-1', sha256: sourceSha256 }, {}, undefined,
    runtimeWith({ copyExclusive: async () => { throw new Error('publish failed'); } })),
    /publish failed/u,
  );
  assert.deepEqual(deleted, ['artifact-2']);
});

