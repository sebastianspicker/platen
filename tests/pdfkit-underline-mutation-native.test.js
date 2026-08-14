import { before, test } from 'node:test';
import * as support from './host-pdfkit-test-support.js';

const {
  assert, chmod, mkdtemp, readFile, rm, stat, writeFile, tmpdir, join, spawnSync,
  makeTextPdf, packagePath,
  runInspection, runMutation, emptyMutation, sourceSha256, directlyEncryptFixture, canRunIntegration,
} = support;

const underline = {
  page: 1,
  subtype: 'underline',
  contents: 'bounded underline contents',
  rect: { x: 72, y: 640, width: 180, height: 24 },
};

function reopenAnnotation(path) {
  const run = spawnSync('xcrun', ['swift', '-', path], {
    input: [
      'import Foundation',
      'import PDFKit',
      'let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!',
      'let annotations = document.page(at: 0)!.annotations.map { annotation in',
      '  ["type": annotation.type ?? "", "contents": annotation.contents ?? "",',
      '   "x": annotation.bounds.origin.x, "y": annotation.bounds.origin.y,',
      '   "width": annotation.bounds.size.width, "height": annotation.bounds.size.height] as [String: Any]',
      '}',
      'let data = try! JSONSerialization.data(withJSONObject: annotations, options: [.sortedKeys])',
      'print(String(data: data, encoding: .utf8)!, terminator: "")',
    ].join('\n'), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--disable-sandbox', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

test('installed PDFKit helper creates one source-bound underline and reopens exact bounded contents and bounds', {
  skip: !canRunIntegration(),
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-underline-'));
  const source = makeTextPdf('underline source');
  const sourcePath = join(workspace, 'input.pdf');
  const outputPath = join(workspace, 'output.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const response = await runMutation(workspace, { ...emptyMutation(), annotations: [underline] });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.sourceSha256, sourceSha256(source));
  assert.equal(response.result.outputSha256, sourceSha256(await readFile(outputPath)));
  assert.equal(response.result.appliedEdits, 1);
  assert.deepEqual(response.result.inspection.pages[0].annotations.map(({ subtype }) => subtype), ['underline']);
  assert.deepEqual(await runInspection(workspace, 'output.pdf').then(({ response: reopened }) => (
    reopened.result.pages[0].annotations.map(({ subtype }) => subtype)
  )), ['underline']);
  assert.deepEqual(reopenAnnotation(outputPath), [{
    type: 'Underline', contents: underline.contents, ...underline.rect,
  }]);
  assert.deepEqual(await readFile(sourcePath), source);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  const outputText = (await readFile(outputPath)).toString('latin1');
  assert.match(outputText, /\/Subtype\s*\/Underline/u);
  assert.doesNotMatch(outputText, /\/URI\b|\/GoToR\b|\/Launch\b|\/AA\b|\/RichMedia\b|\/Movie\b/u);
});

test('installed PDFKit helper keeps the standard subtype and encrypted-source gate closed', {
  skip: !canRunIntegration(),
}, async () => {
  const unsupportedWorkspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-underline-unsupported-'));
  const unsupportedSource = makeTextPdf('unsupported underline source');
  await writeFile(join(unsupportedWorkspace, 'input.pdf'), unsupportedSource, { mode: 0o600 });
  await chmod(unsupportedWorkspace, 0o700);
  const unsupported = await runMutation(unsupportedWorkspace, {
    ...emptyMutation(), annotations: [{ ...underline, subtype: 'strikeOut' }],
  });
  assert.deepEqual(unsupported, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  assert.deepEqual(await readFile(join(unsupportedWorkspace, 'input.pdf')), unsupportedSource);

  const encrypted = await directlyEncryptFixture(makeTextPdf('encrypted source'));
  const rejected = [
    { name: 'encrypted', source: encrypted.encrypted },
  ];
  for (const entry of rejected) {
    const workspace = entry.name === 'encrypted'
      ? encrypted.workspace : await mkdtemp(join(tmpdir(), `pdfkit-helper-underline-${entry.name}-`));
    try {
      await writeFile(join(workspace, 'input.pdf'), entry.source, { mode: 0o600 });
      await chmod(workspace, 0o700);
      const response = await runMutation(workspace, { ...emptyMutation(), annotations: [underline] });
      assert.deepEqual(response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } }, entry.name);
      assert.deepEqual(await readFile(join(workspace, 'input.pdf')), entry.source, entry.name);
      await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
    } finally {
      if (workspace !== encrypted.workspace) await rm(workspace, { recursive: true, force: true });
    }
  }
  await rm(encrypted.workspace, { recursive: true, force: true });
});
