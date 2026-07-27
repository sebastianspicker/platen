import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { before, test } from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { canRunIntegration, packagePath, productPath } from './host-pdfkit-test-support.js';

const limits = {
  maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50, maxOutlineDepth: 8, maxOutlineItems: 200,
};

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--disable-sandbox', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

function request(source, bookmark) {
  return {
    version: 1, operation: 'appendOutlineBookmark', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: digest(source), limits, bookmark,
  };
}

async function workspace(source, body) {
  const directory = await mkdtemp(join(tmpdir(), 'pdfkit-outline-bookmark-'));
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'input.pdf'), source, { mode: 0o600 });
  await writeFile(join(directory, 'request.json'), JSON.stringify(body), { mode: 0o600 });
  return directory;
}

function run(directory) {
  const result = spawnSync(productPath, ['--request', join(directory, 'request.json')], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('native PDFKit appends exactly one top-level CropBox bookmark with a compact bound receipt', { skip: !canRunIntegration() }, async () => {
  const source = makeMultiPagePdf(['first', 'second'], {
    cropBoxes: [[0, 0, 500, 700], [10, 20, 510, 720]],
    outlines: [{ title: 'Existing', page: 1, directDestination: true }],
  });
  const directory = await workspace(source, request(source, { page: 2, label: 'Append' }));
  const response = run(directory);

  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationInventoryVerified', 'appliedEdits', 'category', 'destinationVerified', 'labelSha256', 'operation',
    'outlineAppended', 'outputSha256', 'page', 'pageCount', 'pageGeometryVerified', 'priorOutlineTreeVerified',
    'rawDestinationVerified', 'reopenVerified', 'schema', 'sourceSha256', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'source', outputSha256: 'output', labelSha256: 'label' }, {
    schema: 'pdfkit-outline-bookmark-receipt-v1', version: 1, operation: 'appendOutlineBookmark',
    category: 'outline-bookmark', sourceSha256: 'source', outputSha256: 'output', labelSha256: 'label', page: 2,
    pageCount: 2, appliedEdits: 1, outlineAppended: true, priorOutlineTreeVerified: true, pageGeometryVerified: true,
    annotationInventoryVerified: true, rawDestinationVerified: true, destinationVerified: true, reopenVerified: true,
  });
  assert.equal(response.result.labelSha256, digest(Buffer.from('Append')));
  assert.deepEqual(await readFile(join(directory, 'input.pdf')), source);
  assert.equal((await stat(join(directory, 'output.pdf'))).mode & 0o777, 0o600);
  assert.equal('label' in response.result, false);
  assert.equal('coordinates' in response.result, false);

  await writeFile(join(directory, 'inspect.json'), JSON.stringify({
    version: 1, operation: 'inspect', inputFilename: 'output.pdf', limits,
  }), { mode: 0o600 });
  const inspected = spawnSync(productPath, ['--request', join(directory, 'inspect.json')], { cwd: directory, encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout).result.outline.items, [
    { title: 'Existing', page: 1, children: [], removalLocator: null },
    { title: 'Append', page: 2, children: [], removalLocator: null },
  ]);
});

test('native PDFKit outline bookmark rejects unroundtrippable GoTo outlines and spoofable labels', { skip: !canRunIntegration() }, async () => {
  const sources = [
    { source: makeMultiPagePdf(['first', 'second'], { outlines: [{ title: 'GoTo', page: 1, action: 'goTo' }] }), label: 'Append' },
    { source: makeMultiPagePdf(['first', 'second']), label: ' e' },
    { source: makeMultiPagePdf(['first', 'second']), label: 'e\u0301' },
    { source: makeMultiPagePdf(['first', 'second']), label: 'safe\u202Elabel' },
  ];
  for (const { source, label } of sources) {
    const directory = await workspace(source, request(source, { page: 2, label }));
    assert.deepEqual(run(directory), {
      version: 1, ok: false, error: { code: label === 'Append' ? 'MUTATION_FAILED' : 'INVALID_REQUEST' },
    });
  }
});
