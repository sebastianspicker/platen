import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runSnapshotRegionCommand } from '../scripts/cli/commands/snapshot-region.mjs';

const command = () => parseCliArguments([
  'snapshot-region', 'input.pdf', '--page', '2', '--region', '-0,0.125,0.5,0.75',
  '--dpi', '144', '--output', 'snapshot.png',
]);

test('snapshot-region parser uses the canonical bounded normalized region contract', () => {
  const value = command();
  assert.equal(value.page, 2);
  assert.equal(value.dpi, 144);
  assert.equal(Object.is(value.region.x, -0), true);
  assert.deepEqual(value.region, { x: -0, y: 0.125, width: 0.5, height: 0.75 });
  for (const args of [
    ['--region', '0,0,0,0.2'],
    ['--region', '0,0,0.1234567,0.2'],
    ['--region', '0.6,0,0.5,0.6'],
    ['--region', '0,0,0.5,0.5', '--dpi', '35'],
    ['--region', '0,0,0.5,0.5', '--output', 'snapshot.pdf'],
  ]) {
    const base = ['snapshot-region', 'input.pdf', '--page', '1'];
    assert.throws(
      () => parseCliArguments([...base, ...args, ...(args.some((entry) => entry === '--output') ? [] : ['--output', 'snapshot.png'])]),
      { code: 'CLI_INVALID_OPTION' },
    );
  }
});

test('snapshot-region CLI binds the document, forwards cancellation, writes PNG exclusively, and emits local proof', async () => {
  const calls = [];
  const output = [];
  const sourcePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const application = {
    service: {
      async renderCropBoxSnapshot(documentId, options) {
        calls.push({ documentId, options });
        return sourcePng;
      },
    },
  };
  const signal = new AbortController().signal;
  await runSnapshotRegionCommand(application, command(), { id: 'doc', sha256: 'a'.repeat(64) }, null, signal, {
    cancelled: () => {},
    canonicalOutputTarget: async (path) => calls.push({ canonical: path }),
    writeExclusive: async (path, bytes, receivedSignal) => output.push({ path, bytes: Buffer.from(bytes), signal: receivedSignal }),
    emit: async (_stdout, value) => output.push({ value }),
  });
  assert.deepEqual(calls[0], { canonical: 'snapshot.png' });
  assert.equal(calls[1].documentId, 'doc');
  assert.deepEqual(calls[1].options, { page: 2, dpi: 144, region: command().region, signal });
  assert.deepEqual(output[0], { path: 'snapshot.png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), signal });
  assert.deepEqual(output[1].value, { kind: 'cropbox-snapshot', sourceSha256: 'a'.repeat(64), page: 2, dpi: 144, region: command().region, bytes: 11, localOnly: true });
  assert.deepEqual(sourcePng, Buffer.alloc(sourcePng.length));
});

test('snapshot-region cancellation after rendering zeroes the PNG and does not publish output', async () => {
  const sourcePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9]);
  let writes = 0;
  await assert.rejects(runSnapshotRegionCommand({ service: { renderCropBoxSnapshot: async () => sourcePng } }, command(), { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, {
    cancelled: (() => { let count = 0; return () => { count += 1; if (count > 1) { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; } }; })(),
    canonicalOutputTarget: async () => {},
    writeExclusive: async () => { writes += 1; },
    emit: async () => {},
  }), { code: 'JOB_CANCELLED' });
  assert.equal(writes, 0);
  assert.deepEqual(sourcePng, Buffer.alloc(sourcePng.length));
});

test('snapshot-region propagates an exclusive-write cancellation without emitting or retaining PNG bytes', async () => {
  const sourcePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9]);
  let emitted = false;
  await assert.rejects(runSnapshotRegionCommand({ service: { renderCropBoxSnapshot: async () => sourcePng } }, command(), { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, {
    cancelled: () => {},
    canonicalOutputTarget: async () => {},
    writeExclusive: async () => { const error = new Error('cancelled during publication'); error.code = 'JOB_CANCELLED'; throw error; },
    emit: async () => { emitted = true; },
  }), { code: 'JOB_CANCELLED' });
  assert.equal(emitted, false);
  assert.deepEqual(sourcePng, Buffer.alloc(sourcePng.length));
});

test('snapshot-region rejects malformed service output before exclusive write', async () => {
  let writes = 0;
  for (const malformed of [Buffer.from('not-png'), Buffer.alloc(16 * 1024 * 1024 + 1), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]) {
    await assert.rejects(runSnapshotRegionCommand({ service: { renderCropBoxSnapshot: async () => malformed } }, command(), { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, {
      cancelled: () => {}, canonicalOutputTarget: async () => {}, writeExclusive: async () => { writes += 1; }, emit: async () => {},
      fail: (code, message) => { const error = new Error(message); error.code = code; throw error; },
    }), { code: 'CLI_INVALID_ENGINE_OUTPUT' });
  }
  assert.equal(writes, 0);
});
