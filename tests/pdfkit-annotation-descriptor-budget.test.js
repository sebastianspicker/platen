import { before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  assert, chmod, mkdtemp, readFile, tmpdir, join, spawnSync, writeFile,
  packagePath, productPath, emptyMutation, makeTargetedSanitizationPdf,
} from './host-pdfkit-test-core.js';
import { canRunIntegration, runMutation } from './host-pdfkit-test-runtime.js';

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

test('PDFKit crop preservation rejects compressed, shared, and cyclic annotation descriptors before output', { skip: !canRunIntegration() }, async () => {
  const compressedAppearance = deflateSync(Buffer.from('q\nQ\n')).toString('latin1');
  const fixtures = [
    makeTargetedSanitizationPdf({
      targetExtra: ' /AP << /N 12 0 R >>',
      extraObjects: [`<< /Type /XObject /Subtype /Form /Filter /FlateDecode /Length ${Buffer.byteLength(compressedAppearance, 'latin1')} >>\nstream\n${compressedAppearance}\nendstream`],
    }),
    makeTargetedSanitizationPdf({
      targetExtra: ' /AP << /N 12 0 R /R 12 0 R >>',
      extraObjects: ['<< /State (shared descriptor node) >>'],
    }),
    makeTargetedSanitizationPdf({
      targetExtra: ' /AP << /N 12 0 R >>',
      extraObjects: ['<< /Next 13 0 R >>', '<< /Previous 12 0 R >>'],
    }),
  ];
  for (const source of fixtures) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-descriptor-budget-'));
    await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const response = await runMutation(workspace, {
      ...emptyMutation(), pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 20, width: 500, height: 700 } },
    });
    assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  }
});
