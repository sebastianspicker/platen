import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { makeLocalGoToAnnotationFixture } from './host-pdfkit-test-fixtures-b.js';
import { canRunIntegration, packagePath, productPath } from './host-pdfkit-test-support.js';

const limits = {
  maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50, maxOutlineDepth: 8, maxOutlineItems: 200,
};

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--disable-sandbox', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fingerprint(source, page, annotationIndex) {
  const descriptor = [
    'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sha256(source)}`, `page=${page}`,
    `annotation-index=${annotationIndex}`, 'subtype=link', 'widget-type=none',
  ].join('\n');
  return sha256(descriptor);
}

function removalRequest(source, page, annotationIndex, locator = fingerprint(source, page, annotationIndex)) {
  return {
    version: 1, operation: 'removeLocalGoToLink', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sha256(source), limits, link: { page, annotationIndex, fingerprint: locator },
  };
}

async function makeWorkspace(source, body) {
  const directory = await mkdtemp(join(tmpdir(), 'pdfkit-local-goto-removal-'));
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
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function derive(source, body) {
  const directory = await makeWorkspace(source, body);
  const { response } = invoke(directory);
  assert.equal(response.ok, true, JSON.stringify(response));
  return readFile(join(directory, 'output.pdf'));
}

async function appendTrailingAnnotation(source) {
  const directory = await mkdtemp(join(tmpdir(), 'pdfkit-local-goto-successor-'));
  const input = join(directory, 'input.pdf'); const output = join(directory, 'output.pdf');
  await writeFile(input, source);
  const script = [
    'import Foundation; import PDFKit',
    'let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!',
    'let annotation = PDFAnnotation(bounds: CGRect(x: 200, y: 100, width: 40, height: 30), forType: .square, withProperties: nil)',
    'annotation.contents = "private successor square"; document.page(at: 0)!.addAnnotation(annotation)',
    'try! document.dataRepresentation()!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))',
  ].join('; ');
  const run = spawnSync('swift', ['-framework', 'Foundation', '-framework', 'PDFKit', '-e', script, input, output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return readFile(output);
}

async function firstPartyLocalGoToSource({ adjacent = false } = {}) {
  let source = makeMultiPagePdf(['source', 'target'], {
    cropBoxes: [[0, 0, 500, 700], [10, 20, 510, 720]],
  });
  if (adjacent) {
    for (const annotation of [
      { page: 1, subtype: 'freeText', contents: 'private adjacent note', rect: { x: 20, y: 100, width: 80, height: 30 } },
      { page: 1, subtype: 'square', contents: 'private adjacent square', rect: { x: 120, y: 100, width: 40, height: 30 } },
    ]) {
      source = await derive(source, {
        version: 1, operation: 'mutate', inputFilename: 'input.pdf', outputFilename: 'output.pdf', limits,
        sourceSha256: sha256(source),
        mutation: { metadata: null, pageBox: null, rotation: null, annotations: [annotation] },
      });
    }
  }
  const withLink = await derive(source, {
    version: 1, operation: 'addLocalGoToLink', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sha256(source), limits,
    link: { sourcePage: 1, targetPage: 2, rect: { x: 40, y: 600, width: 180, height: 30 } },
  });
  return adjacent ? appendTrailingAnnotation(withLink) : withLink;
}

async function inspect(directory, inputFilename, requestFilename) {
  await writeFile(join(directory, requestFilename), JSON.stringify({
    version: 1, operation: 'inspect', inputFilename, limits,
  }), { mode: 0o600 });
  return invoke(directory, requestFilename).response.result;
}

async function inspectSource(source) {
  const directory = await makeWorkspace(source, {
    version: 1, operation: 'inspect', inputFilename: 'input.pdf', limits,
  });
  return invoke(directory).response.result;
}

test('native PDFKit removes one source-bound local GoTo while preserving the adjacent annotation', { skip: !canRunIntegration() }, async () => {
  const source = await firstPartyLocalGoToSource({ adjacent: true });
  const sourceInspection = await inspectSource(source);
  const sourceSubtypes = sourceInspection.pages[0].annotations.map(({ subtype }) => subtype);
  assert.deepEqual(sourceSubtypes, ['freeText', 'square', 'link', 'square']);
  const linkIndex = sourceSubtypes.indexOf('link');
  const directory = await makeWorkspace(source, removalRequest(source, 1, linkIndex));
  const { response, raw } = invoke(directory);

  assert.equal(response.ok, true, raw);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationIndex', 'annotationInventoryVerified', 'annotationRemoved', 'appliedEdits', 'category', 'operation',
    'outputSha256', 'page', 'pageCount', 'pageGeometryVerified', 'rawTargetVerified', 'reopenVerified', 'schema',
    'sourceSha256', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'source', outputSha256: 'output' }, {
    schema: 'pdfkit-local-goto-removal-receipt-v1', version: 1, operation: 'removeLocalGoToLink',
    category: 'local-goto-link-removal', sourceSha256: 'source', outputSha256: 'output', page: 1,
    annotationIndex: linkIndex, pageCount: 2, appliedEdits: 1, rawTargetVerified: true, annotationRemoved: true,
    pageGeometryVerified: true, annotationInventoryVerified: true, reopenVerified: true,
  });
  assert.equal('destination' in response.result, false);
  assert.equal('targetPage' in response.result, false);
  assert.doesNotMatch(raw, /private adjacent note|private adjacent square|private successor square|"rect"|"targetPage"|"destination"/);
  assert.deepEqual(await readFile(join(directory, 'input.pdf')), source);
  assert.equal((await stat(join(directory, 'output.pdf'))).mode & 0o777, 0o600);

  const before = await inspect(directory, 'input.pdf', 'inspect-before.json');
  const after = await inspect(directory, 'output.pdf', 'inspect-after.json');
  assert.deepEqual(before.pages.map(({ boxes, rotation }) => ({ boxes, rotation })),
    after.pages.map(({ boxes, rotation }) => ({ boxes, rotation })));
  assert.deepEqual(before.pages[0].annotations.map(({ subtype }) => subtype), ['freeText', 'square', 'link', 'square']);
  assert.deepEqual(after.pages[0].annotations.map(({ subtype }) => subtype), ['freeText', 'square', 'square']);
  const outputText = (await readFile(join(directory, 'output.pdf'))).toString('latin1');
  assert.doesNotMatch(outputText, /\/Dest\b|\/URI\b|\/GoToR\b|\/S\s*\/GoTo\b/);
});

test('native PDFKit local GoTo removal rejects stale locators and non-local or malformed active links', { skip: !canRunIntegration() }, async () => {
  const strict = await firstPartyLocalGoToSource();
  const invalid = [
    { source: strict, request: removalRequest(strict, 1, 0, '0'.repeat(64)) },
    { source: strict, request: removalRequest(strict, 1, 1) },
    {
      source: makeLocalGoToAnnotationFixture({
        annotation: '<< /Type /Annot /Subtype /Link /Rect [40 600 220 630] /A << /S /URI /URI (https://example.invalid) >> >>',
      }),
    },
    {
      source: makeLocalGoToAnnotationFixture({
        annotation: '<< /Type /Annot /Subtype /Link /Rect [40 600 220 630] /A << /S /GoToR /F (remote.pdf) /D [0 /Fit] >> >>',
      }),
    },
    {
      source: makeLocalGoToAnnotationFixture({
        annotation: '<< /Type /Annot /Subtype /Link /Rect [40 600 220 630] /Dest [4 0 R /XYZ 10 720 null] /A << /S /GoTo /D [4 0 R /XYZ 10 720 null] /Next /FirstPage >> >>',
      }),
    },
  ];
  for (const entry of invalid) {
    const request = entry.request ?? removalRequest(entry.source, 1, 0);
    const directory = await makeWorkspace(entry.source, request);
    assert.deepEqual(invoke(directory).response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
    assert.deepEqual(await readFile(join(directory, 'input.pdf')), entry.source);
    await assert.rejects(readFile(join(directory, 'output.pdf')), { code: 'ENOENT' });
  }
});
