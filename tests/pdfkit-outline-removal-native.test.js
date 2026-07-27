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

function injectedInfoDates(data) {
  const source = data.toString('latin1');
  const creation = source.match(/\/CreationDate\s+\((D:[^)]*)\)/u)?.[1];
  const modification = source.match(/\/ModDate\s+\((D:[^)]*)\)/u)?.[1];
  assert.ok(creation);
  assert.ok(modification);
  return { creation, modification };
}

async function workspace(source, body) {
  const directory = await mkdtemp(join(tmpdir(), 'pdfkit-outline-removal-'));
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'input.pdf'), source, { mode: 0o600 });
  await writeFile(join(directory, 'request.json'), JSON.stringify(body), { mode: 0o600 });
  return directory;
}

function invoke(directory, requestFilename = 'request.json') {
  const run = spawnSync(productPath, ['--request', join(directory, requestFilename)], {
    cwd: directory, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout, stderr: run.stderr };
}

async function appendOutline(source, bookmark) {
  const directory = await workspace(source, {
    version: 1, operation: 'appendOutlineBookmark', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: digest(source), limits, bookmark,
  });
  const { response } = invoke(directory);
  assert.equal(response.ok, true, JSON.stringify(response));
  return readFile(join(directory, 'output.pdf'));
}

async function inspect(source) {
  const directory = await workspace(source, {
    version: 1, operation: 'inspect', inputFilename: 'input.pdf', limits,
  });
  return invoke(directory).response.result;
}

function removalRequest(source, locator) {
  return {
    version: 1, operation: 'removeOutlineBookmark', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: digest(source), limits, bookmark: locator,
  };
}

test('native PDFKit removes exactly one fully inspected top-level direct-destination outline leaf', { skip: !canRunIntegration() }, async () => {
  const initial = makeMultiPagePdf(['first', 'second'], {
    cropBoxes: [[0, 0, 500, 700], [10, 20, 510, 720]],
  });
  const first = await appendOutline(initial, { page: 1, label: 'Private first title' });
  const source = await appendOutline(first, { page: 2, label: 'Private second title' });
  const sourceDates = injectedInfoDates(source);
  const before = await inspect(source);
  const items = before.outline.items;
  assert.deepEqual(items.map(({ title, page, children }) => ({ title, page, children })), [
    { title: 'Private first title', page: 1, children: [] },
    { title: 'Private second title', page: 2, children: [] },
  ]);
  assert.deepEqual(items.map(({ removalLocator }) => removalLocator?.topLevelIndex), [0, 1]);
  assert.ok(items.every(({ removalLocator }) => /^[a-f0-9]{64}$/u.test(removalLocator?.fingerprint ?? '')));
  const directory = await workspace(source, removalRequest(source, items[1].removalLocator));
  const { response, raw, stderr } = invoke(directory);
  assert.equal(response.ok, true, `${raw}${stderr}`);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationInventoryVerified', 'appliedEdits', 'category', 'contentSnapshotVerified', 'operation', 'outlineRemoved',
    'outputSha256', 'pageCount', 'pageGeometryVerified', 'rawTargetVerified', 'remainingOutlineTreeVerified', 'reopenVerified',
    'schema', 'sourceSha256', 'topLevelIndex', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'source', outputSha256: 'output' }, {
    schema: 'pdfkit-outline-removal-receipt-v1', version: 1, operation: 'removeOutlineBookmark',
    category: 'outline-bookmark-removal', sourceSha256: 'source', outputSha256: 'output', topLevelIndex: 1,
    pageCount: 2, appliedEdits: 1, rawTargetVerified: true, outlineRemoved: true,
    remainingOutlineTreeVerified: true, pageGeometryVerified: true, annotationInventoryVerified: true,
    contentSnapshotVerified: true, reopenVerified: true,
  });
  assert.equal('fingerprint' in response.result, false);
  assert.doesNotMatch(raw, /Private first title|Private second title|"destination"|"point"|"fingerprint"/u);
  assert.deepEqual(await readFile(join(directory, 'input.pdf')), source);
  assert.equal((await stat(join(directory, 'output.pdf'))).mode & 0o777, 0o600);

  const output = await readFile(join(directory, 'output.pdf'));
  assert.deepEqual(injectedInfoDates(output), sourceDates);
  const after = await inspect(output);
  assert.deepEqual(after.pages.map(({ boxes, rotation }) => ({ boxes, rotation })),
    before.pages.map(({ boxes, rotation }) => ({ boxes, rotation })));
  assert.deepEqual(after.outline.items.map(({ title, page, children }) => ({ title, page, children })), [
    { title: 'Private first title', page: 1, children: [] },
  ]);
});

test('native PDFKit rejects stale or non-strict direct-destination outline removal locators', { skip: !canRunIntegration() }, async () => {
  const initial = makeMultiPagePdf(['first', 'second']);
  const strict = await appendOutline(initial, { page: 1, label: 'Strict' });
  const strictInspection = await inspect(strict);
  const invalid = [
    { source: strict, locator: { ...strictInspection.outline.items[0].removalLocator, fingerprint: '0'.repeat(64) } },
    {
      source: makeMultiPagePdf(['first', 'second'], { outlines: [{ title: 'Fit', page: 1, directDestination: true }] }),
      locator: { topLevelIndex: 0, fingerprint: '0'.repeat(64) },
    },
    {
      source: makeMultiPagePdf(['first', 'second'], { outlines: [{ title: 'GoTo', page: 1, action: 'goTo' }] }),
      locator: { topLevelIndex: 0, fingerprint: '0'.repeat(64) },
    },
  ];
  for (const { source, locator } of invalid) {
    const directory = await workspace(source, removalRequest(source, locator));
    assert.deepEqual(invoke(directory).response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    assert.deepEqual(await readFile(join(directory, 'input.pdf')), source);
  }
});
