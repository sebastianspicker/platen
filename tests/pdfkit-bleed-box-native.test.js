import { before, test } from 'node:test';
import * as support from './host-pdfkit-test-support.js';

const {
  assert, chmod, mkdtemp, readFile, stat, unlink, writeFile, tmpdir, join, spawnSync,
  makeMultiPagePdf, makeTextPdf, packagePath, runInspection, runMutation, emptyMutation,
  makeNavigationPdf, canRunIntegration,
} = support;

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const releaseBuild = spawnSync('swift', ['build', '-c', 'release', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(releaseBuild.status, 0, releaseBuild.stderr);
});

test('installed PDFKit helper applies one selected-page bleed box and preserves every other resolved page state', { skip: !canRunIntegration() }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-bleed-'));
  const seed = makeMultiPagePdf(['bleed source one', 'bleed source two'], {
    rotations: [90, 180],
    cropBoxes: [[10, 20, 500, 700], [30, 40, 520, 710]],
    bleedBoxes: [[20, 30, 490, 690], [40, 50, 510, 700]],
    trimBoxes: [[50, 60, 450, 650], [60, 70, 440, 640]],
  });
  await writeFile(join(workspace, 'input.pdf'), seed, { mode: 0o600 });
  await chmod(workspace, 0o700);

  const seeded = await runMutation(workspace, {
    ...emptyMutation(), annotations: [{
      page: 1, subtype: 'freeText', contents: 'existing inert note', rect: { x: 72, y: 540, width: 200, height: 40 },
    }],
  });
  assert.equal(seeded.ok, true);
  const source = await readFile(join(workspace, 'output.pdf'));
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  await unlink(join(workspace, 'output.pdf'));
  await unlink(join(workspace, 'request.json'));

  const before = await runInspection(workspace);
  const target = { x: 12, y: 18, width: 580, height: 756 };
  const response = await runMutation(workspace, {
    ...emptyMutation(), pageBox: { page: 1, box: 'bleed', rect: target },
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.appliedEdits, 1);
  assert.deepEqual(response.result.inspection.pages[0].boxes.bleed, target);
  assert.deepEqual(
    response.result.inspection.pages.map(({ boxes }) => ({
      media: boxes.media, crop: boxes.crop, trim: boxes.trim, art: boxes.art,
    })),
    before.response.result.pages.map(({ boxes }) => ({
      media: boxes.media, crop: boxes.crop, trim: boxes.trim, art: boxes.art,
    })),
  );
  assert.deepEqual(
    response.result.inspection.pages.slice(1).map((page) => page.boxes.bleed),
    before.response.result.pages.slice(1).map((page) => page.boxes.bleed),
  );
  assert.deepEqual(
    response.result.inspection.pages.map((page) => page.rotation),
    before.response.result.pages.map((page) => page.rotation),
  );
  assert.deepEqual(
    response.result.inspection.pages.map((page) => ({
      count: page.annotations.length, subtypes: page.annotations.map((annotation) => annotation.subtype),
    })),
    before.response.result.pages.map((page) => ({
      count: page.annotations.length, subtypes: page.annotations.map((annotation) => annotation.subtype),
    })),
  );
  const reopened = await runInspection(workspace, 'output.pdf');
  assert.deepEqual(reopened.response.result, response.result.inspection);
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), source);
  assert.notDeepEqual(await readFile(join(workspace, 'output.pdf')), source);
  assert.equal((await stat(join(workspace, 'output.pdf'))).mode & 0o777, 0o600);
});

test('installed PDFKit helper rejects malformed, no-op, outside, multi-category, unsafe, and pre-existing bleed-box outputs', { skip: !canRunIntegration() }, async () => {
  const safeSource = makeTextPdf('bleed source');
  const bleed = { page: 1, box: 'bleed', rect: { x: 10, y: 20, width: 500, height: 700 } };
  const rejected = [
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...bleed, extra: true } }, code: 'INVALID_REQUEST' },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...bleed, page: null } }, code: 'INVALID_REQUEST' },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...bleed, rect: { x: 0, y: 0, width: 612, height: 792 } } }, code: 'MUTATION_FAILED' },
    {
      source: makeTextPdf('explicit bleed no-op', {
        cropBoxes: [[0, 0, 600, 780]],
        bleedBoxes: [[10, 20, 510, 720]],
        trimBoxes: [[20, 30, 500, 700]],
      }),
      mutation: { ...emptyMutation(), pageBox: bleed },
      code: 'MUTATION_FAILED',
    },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...bleed, rect: { x: 600, y: 700, width: 20, height: 20 } } }, code: 'MUTATION_FAILED' },
    {
      source: makeTextPdf('trim exclusion', { trimBoxes: [[100, 100, 500, 700]] }),
      mutation: { ...emptyMutation(), pageBox: { ...bleed, rect: { x: 10, y: 20, width: 80, height: 80 } } },
      code: 'MUTATION_FAILED',
    },
    { source: safeSource, mutation: { ...emptyMutation(), pageBox: { ...bleed, page: 2 } }, code: 'MUTATION_FAILED' },
    {
      source: safeSource,
      mutation: { ...emptyMutation(), metadata: { title: 'also a category', author: null, subject: null, keywords: null }, pageBox: bleed },
      code: 'INVALID_REQUEST',
    },
    { source: makeNavigationPdf(), mutation: { ...emptyMutation(), pageBox: bleed }, code: 'MUTATION_FAILED' },
  ];
  for (const entry of rejected) {
    const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-bleed-reject-'));
    await writeFile(join(workspace, 'input.pdf'), entry.source, { mode: 0o600 });
    await chmod(workspace, 0o700);
    const response = await runMutation(workspace, entry.mutation);
    assert.deepEqual(response, { version: 1, ok: false, error: { code: entry.code } });
    assert.deepEqual(await readFile(join(workspace, 'input.pdf')), entry.source);
    await assert.rejects(readFile(join(workspace, 'output.pdf')), { code: 'ENOENT' });
  }

  const workspace = await mkdtemp(join(tmpdir(), 'pdfkit-helper-bleed-output-exists-'));
  const outputSource = makeTextPdf('bleed output', { trimBoxes: [[100, 100, 500, 700]] });
  const existingOutput = Buffer.from('must not be replaced');
  await writeFile(join(workspace, 'input.pdf'), outputSource, { mode: 0o600 });
  await writeFile(join(workspace, 'output.pdf'), existingOutput, { mode: 0o600 });
  await chmod(workspace, 0o700);
  const response = await runMutation(workspace, { ...emptyMutation(), pageBox: bleed });
  assert.deepEqual(response, { version: 1, ok: false, error: { code: 'OUTPUT_EXISTS' } });
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), outputSource);
  assert.deepEqual(await readFile(join(workspace, 'output.pdf')), existingOutput);
});
