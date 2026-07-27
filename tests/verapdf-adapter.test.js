import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVeraPdfValidationArgs, parseVeraPdfProfileList, parseVeraPdfVersion, VeraPdfAdapter, VERAPDF_PROFILE_MAP } from '../scripts/host/adapters/verapdf.mjs';

const bundle = Object.freeze({ launcher: '/trusted/verapdf', version: '1.30.1', profileMap: VERAPDF_PROFILE_MAP, evidence: Object.freeze({ bundleDigest: 'a'.repeat(64), componentCount: 1 }) });
const flavours = `veraPDF supported PDF/A and PDF/UA profiles:\n${Object.values(VERAPDF_PROFILE_MAP).map((flavour) => `  ${flavour} - ${flavour} validation profile`).join('\n')}\n  wt1a - WTPDF accessibility validation profile`;

test('veraPDF adapter exposes only fixed PDF/A and PDF/UA argv', () => {
  assert.deepEqual(buildVeraPdfValidationArgs('pdfa-4f', '/jobs/input.pdf'), ['--format', 'json', '--loglevel', '0', '--disableerrormessages', '--maxfailuresdisplayed', '1', '--flavour', '4f', '/jobs/input.pdf']);
  assert.throws(() => buildVeraPdfValidationArgs('pdfx-4', '/jobs/input.pdf'), /supported fixed/);
  assert.throws(() => buildVeraPdfValidationArgs('pdfa-1a', 'input.pdf'), /absolute path/);
  assert.equal(parseVeraPdfVersion('veraPDF 1.30.1\n'), '1.30.1');
  assert.equal(parseVeraPdfProfileList(flavours).ua2, 'ua2 validation profile');
  assert.throws(() => parseVeraPdfVersion('build veraPDF 1.30.1'), /not recognized/);
  assert.throws(() => parseVeraPdfProfileList(`${flavours}\nua2 - duplicate`), /not recognized/);
});

test('veraPDF adapter probes fixed bundle and treats only exit one as completed noncompliance', async () => {
  const calls = [];
  const adapter = new VeraPdfAdapter({ bundle, runner: async (call) => { calls.push(call); if (call.args[0] === '--version') return { stdout: 'veraPDF 1.30.1', exitCode: 0 }; if (call.args[0] === '--list') return { stdout: flavours, exitCode: 0 }; return { stdout: '{"valid":false}', stderr: '', exitCode: call.args.includes('ua2') ? 2 : 1 }; } });
  const probe = await adapter.probe({ cwd: '/jobs/private', environment: { HOME: '/jobs/private/home' } });
  assert.equal(probe.version, '1.30.1');
  assert.deepEqual(probe.profiles, [...Object.values(VERAPDF_PROFILE_MAP)].sort());
  assert.equal(probe.profileNames['pdfua-2'], 'ua2 validation profile');
  assert.equal(calls[0].timeoutMs, 5_000); assert.equal(calls[1].maxStdoutBytes, 64 * 1024);
  const result = await adapter.execute('pdfua-1', '/jobs/input.pdf', { cwd: '/jobs/private', environment: { HOME: '/jobs/private/home' }, executable: '/evil', args: ['--evil'] });
  assert.equal(result.compliant, false); assert.equal(result.completed, true);
  assert.deepEqual(calls.at(-1).args, ['--format', 'json', '--loglevel', '0', '--disableerrormessages', '--maxfailuresdisplayed', '1', '--flavour', 'ua1', '/jobs/input.pdf']);
  assert.equal(calls.at(-1).executable, '/trusted/verapdf');
  await assert.rejects(adapter.execute('pdfua-2', '/jobs/input.pdf', { cwd: '/jobs/private' }), /unexpected status/);
});
