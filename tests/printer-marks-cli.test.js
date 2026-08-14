import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrinterMarksCommand } from '../scripts/cli/commands/printer-marks.mjs';
import { PDF_PRINTER_MARKS_PROFILE } from '../scripts/host/pdf-printer-marks-contract.mjs';
import { parseCliArguments } from '../scripts/platen-cli.mjs';

test('printer-marks CLI parses ranges and publishes one exclusive artifact', async () => {
  assert.deepEqual(parseCliArguments(['printer-marks', 'input.pdf', '--pages', '1,3-5', '--output', 'output.pdf']), { command: 'printer-marks', input: 'input.pdf', pages: [1, 3, 4, 5], output: 'output.pdf' });
  assert.throws(() => parseCliArguments(['printer-marks', 'input.pdf', '--pages', '3,1', '--output', 'output.pdf']), { code: 'CLI_INVALID_OPTION' });
  const calls = []; const application = { printerMarks: { create: async (...args) => { calls.push(args); return { kind: 'pdf-printer-marks', artifact: { id: 'artifact' } }; } }, store: { getArtifact: () => ({ filePath: '/private/printer-marks.pdf' }) } };
  await runPrinterMarksCommand(application, { pages: [1, 3], output: '/tmp/out.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, { cancelled() {}, canonicalOutputTarget: async () => {}, copyExclusive: (...args) => calls.push(args), emit: async () => {}, fail(code) { throw Object.assign(new Error(code), { code }); } });
  assert.deepEqual(calls[0][1], { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: 'a'.repeat(64), pages: [1, 3] }); assert.deepEqual(calls[1], ['/private/printer-marks.pdf', '/tmp/out.pdf']);
});

test('printer-marks CLI revokes a promoted artifact when cancellation arrives before copy', async () => {
  const deleted = [];
  const application = { printerMarks: { create: async () => ({ kind: 'pdf-printer-marks', artifact: { id: 'artifact' } }) }, store: { deleteArtifact: async (id) => deleted.push(id) } };
  let checks = 0;
  await assert.rejects(runPrinterMarksCommand(application, { pages: [1], output: '/tmp/out.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, {
    cancelled() { if (++checks > 1) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); }, canonicalOutputTarget: async () => {}, fail(code) { throw Object.assign(new Error(code), { code }); },
  }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(deleted, ['artifact']);
});
