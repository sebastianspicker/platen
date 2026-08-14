import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { makeTextPdf } from './pdf-fixture.js';
import { canRunIntegration, packagePath, productPath } from './host-pdfkit-test-support.js';

const limits = {
  maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50,
  maxOutlineDepth: 8, maxOutlineItems: 200,
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync(
    'swift', ['build', '--disable-sandbox', '--package-path', packagePath],
    { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr);
});

test('native PDFKit helper creates one source-bound terminal AcroForm text widget', {
  skip: !canRunIntegration(),
}, async () => {
  const source = makeTextPdf('Native text-field widget source');
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-text-field-native-'));
  await chmod(workspace, 0o700);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  const field = {
    page: 1,
    rect: { x: 36, y: 36, width: 180, height: 24 },
    name: 'Account.Name',
    defaultValue: 'Private local value',
  };
  await writeFile(join(workspace, 'request.json'), JSON.stringify({
    version: 1, operation: 'addTextFieldWidget',
    inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: digest(source), limits, field,
  }), { mode: 0o600 });
  const run = spawnSync(productPath, ['--request', join(workspace, 'request.json')], {
    cwd: workspace, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const response = JSON.parse(run.stdout);
  assert.equal(response.ok, true, run.stdout);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'appliedEdits', 'category', 'defaultValueSha256',
    'directAcroFormTopologyVerified', 'fieldNameSha256', 'operation',
    'outputSha256', 'page', 'pageCount', 'preservationVerified', 'rectSha256',
    'reopenVerified', 'schema', 'sourceSafetyVerified', 'sourceSha256',
    'terminalTextWidgetVerified', 'version',
  ]);
  assert.equal(response.result.schema, 'pdfkit-text-field-widget-receipt-v1');
  assert.equal(response.result.sourceSha256, digest(source));
  assert.equal(response.result.page, 1);
  assert.equal(response.result.appliedEdits, 1);
  assert.equal(response.result.directAcroFormTopologyVerified, true);
  assert.equal(response.result.terminalTextWidgetVerified, true);
  assert.notEqual(response.result.outputSha256, response.result.sourceSha256);
  assert.doesNotMatch(run.stdout, /Account\.Name|Private local value|input\.pdf|output\.pdf/u);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.equal(digest(await readFile(join(workspace, 'output.pdf'))), response.result.outputSha256);
});
