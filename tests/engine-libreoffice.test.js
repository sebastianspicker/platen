import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLibreOfficeToPdfArgs, LibreOfficeAdapter } from '../scripts/host/adapters/libreoffice.mjs';

const workspace = '/jobs/private';

test('LibreOffice builder constructs a fixed headless office-to-PDF invocation', () => {
  assert.deepEqual(buildLibreOfficeToPdfArgs({
    input: '/documents/Quarterly report.odt', output: `${workspace}/Quarterly report.pdf`, workspace,
  }), [
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard',
    '-env:UserInstallation=file:///jobs/private/libreoffice-profile',
    '--convert-to', 'pdf:writer_pdf_Export', '--outdir', workspace, '/documents/Quarterly report.odt',
  ]);
});

test('LibreOffice builder rejects caller-controlled output and input paths', () => {
  assert.throws(() => buildLibreOfficeToPdfArgs({ input: 'report.odt', output: `${workspace}/report.pdf`, workspace }), /input must be an absolute path/);
  assert.throws(() => buildLibreOfficeToPdfArgs({ input: '/documents/report.odt', output: '/tmp/report.pdf', workspace }), /inside workspace/);
  assert.throws(() => buildLibreOfficeToPdfArgs({ input: '/documents/report.odt', output: `${workspace}/other.pdf`, workspace }), /deterministic PDF name/);
});

test('LibreOffice adapter pins soffice and the private workspace', async () => {
  const calls = [];
  const adapter = new LibreOfficeAdapter({
    registry: { probe: async (name) => ({ name, executable: '/engines/soffice' }) },
    runner: async (invocation) => { calls.push(invocation); return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  await adapter.execute('convertOfficeToPdf', { input: '/documents/report.docx', output: `${workspace}/report.pdf`, workspace }, {
    signal: undefined, executable: '/untrusted', cwd: '/tmp', args: ['--unsafe'],
  });
  assert.deepEqual(calls, [{
    signal: undefined, executable: '/engines/soffice', cwd: workspace,
    environment: {
      HOME: workspace,
      TMPDIR: workspace,
      XDG_CACHE_HOME: workspace,
      XDG_CONFIG_HOME: workspace,
      XDG_RUNTIME_DIR: workspace,
      SAL_USE_VCLPLUGIN: 'svp',
    },
    args: ['--headless', '--nologo', '--nodefault', '--nofirststartwizard', '-env:UserInstallation=file:///jobs/private/libreoffice-profile', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', workspace, '/documents/report.docx'],
  }]);
});
