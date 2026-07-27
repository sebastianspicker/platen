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

function digest(data) { return createHash('sha256').update(data).digest('hex'); }

function injectedInfoDates(data) {
  const source = data.toString('latin1');
  const creation = source.match(/\/CreationDate\s+\((D:[^)]*)\)/u)?.[1];
  const modification = source.match(/\/ModDate\s+\((D:[^)]*)\)/u)?.[1];
  assert.ok(creation);
  assert.ok(modification);
  return { creation, modification };
}

async function workspace(source, body) {
  const directory = await mkdtemp(join(tmpdir(), 'pdfkit-outline-rename-'));
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'input.pdf'), source, { mode: 0o600 });
  await writeFile(join(directory, 'request.json'), JSON.stringify(body), { mode: 0o600 });
  return directory;
}

function invoke(directory) {
  const run = spawnSync(productPath, ['--request', join(directory, 'request.json')], { cwd: directory, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout), raw: run.stdout };
}

async function appendOutline(source, bookmark) {
  const directory = await workspace(source, {
    version: 1, operation: 'appendOutlineBookmark', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: digest(source), limits, bookmark,
  });
  assert.equal(invoke(directory).response.ok, true);
  return readFile(join(directory, 'output.pdf'));
}

async function inspect(source) {
  const directory = await workspace(source, { version: 1, operation: 'inspect', inputFilename: 'input.pdf', limits });
  return invoke(directory).response.result;
}

function renameRequest(source, bookmarkRename) {
  return {
    version: 1, operation: 'renameOutlineBookmark', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: digest(source), limits, bookmarkRename,
  };
}

function strictNestedOutlinePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    '<< /Length 35 >>\nstream\nBT /F1 18 Tf 72 720 Td (one) Tj ET\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>',
    '<< /Length 35 >>\nstream\nBT /F1 18 Tf 72 720 Td (two) Tj ET\nendstream',
    '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
    '<< /Title (Top) /Parent 8 0 R /First 10 0 R /Last 10 0 R /Count 1 /Dest [4 0 R /XYZ 72 720 null] >>',
    '<< /Title (Child) /Parent 9 0 R /Dest [6 0 R /XYZ 72 720 null] >>',
  ];
  let body = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('native PDFKit renames one source-bound top-level leaf while preserving the document and keeping the receipt private', { skip: !canRunIntegration() }, async () => {
  const initial = makeMultiPagePdf(['first', 'second'], { cropBoxes: [[0, 0, 500, 700], [10, 20, 510, 720]] });
  const first = await appendOutline(initial, { page: 1, label: 'Private first title' });
  const source = await appendOutline(first, { page: 2, label: 'Private second title' });
  const sourceDates = injectedInfoDates(source);
  const before = await inspect(source);
  const newLabel = 'Renamed Caf\u00e9 (safe) \\ title';
  const directory = await workspace(source, renameRequest(source, { ...before.outline.items[1].removalLocator, label: newLabel }));
  const { response, raw } = invoke(directory);
  assert.equal(response.ok, true, raw);
  assert.deepEqual(Object.keys(response.result).sort(), [
    'annotationInventoryVerified', 'appliedEdits', 'category', 'contentSnapshotVerified', 'labelSha256', 'operation',
    'outlineRenamed', 'outputSha256', 'pageCount', 'pageGeometryVerified', 'rawTargetVerified',
    'remainingOutlineTreeVerified', 'reopenVerified', 'schema', 'sourceSha256', 'topLevelIndex', 'version',
  ]);
  assert.deepEqual({ ...response.result, sourceSha256: 'source', outputSha256: 'output', labelSha256: 'label' }, {
    schema: 'pdfkit-outline-rename-receipt-v1', version: 1, operation: 'renameOutlineBookmark', category: 'outline-bookmark-rename',
    sourceSha256: 'source', outputSha256: 'output', topLevelIndex: 1, labelSha256: 'label', pageCount: 2, appliedEdits: 1,
    rawTargetVerified: true, outlineRenamed: true,
    remainingOutlineTreeVerified: true, pageGeometryVerified: true, annotationInventoryVerified: true,
    contentSnapshotVerified: true, reopenVerified: true,
  });
  assert.equal(response.result.labelSha256, digest(Buffer.from(newLabel)));
  assert.doesNotMatch(raw, /Private first title|Private second title|Renamed Caf|fingerprint|destination|point/u);
  assert.deepEqual(await readFile(join(directory, 'input.pdf')), source);
  assert.equal((await stat(join(directory, 'output.pdf'))).mode & 0o777, 0o600);

  const output = await readFile(join(directory, 'output.pdf'));
  assert.deepEqual(injectedInfoDates(output), sourceDates);
  const after = await inspect(output);
  assert.deepEqual(after.pages.map(({ boxes, rotation }) => ({ boxes, rotation })), before.pages.map(({ boxes, rotation }) => ({ boxes, rotation })));
  assert.deepEqual(after.outline.items.map(({ title, page, children }) => ({ title, page, children })), [
    { title: 'Private first title', page: 1, children: [] }, { title: newLabel, page: 2, children: [] },
  ]);
});

test('native PDFKit rejects stale, no-op, non-NFC, nested, action, and unsafe outline rename targets', { skip: !canRunIntegration() }, async () => {
  const source = await appendOutline(makeMultiPagePdf(['first', 'second']), { page: 1, label: 'Strict' });
  const locator = (await inspect(source)).outline.items[0].removalLocator;
  const failures = [
    { source, target: { ...locator, fingerprint: '0'.repeat(64), label: 'Renamed' }, code: 'MUTATION_FAILED' },
    { source, target: { ...locator, label: 'Strict' }, code: 'MUTATION_FAILED' },
    { source, target: { ...locator, label: ' Renamed' }, code: 'INVALID_REQUEST' },
    { source, target: { ...locator, label: 'Cafe\u0301' }, code: 'INVALID_REQUEST' },
    { source, target: { ...locator, label: 'safe\u202Elabel' }, code: 'INVALID_REQUEST' },
    { source, target: { ...locator, label: 'safe\nlabel' }, code: 'INVALID_REQUEST' },
    { source: strictNestedOutlinePdf(), target: { topLevelIndex: 0, fingerprint: '0'.repeat(64), label: 'Renamed' }, code: 'MUTATION_FAILED' },
    { source: makeMultiPagePdf(['first', 'second'], { outlines: [{ title: 'Action', page: 1, action: 'goTo' }] }), target: { topLevelIndex: 0, fingerprint: '0'.repeat(64), label: 'Renamed' }, code: 'MUTATION_FAILED' },
    { source: makeMultiPagePdf(['first'], { tagged: true }), target: { topLevelIndex: 0, fingerprint: '0'.repeat(64), label: 'Renamed' }, code: 'MUTATION_FAILED' },
  ];
  for (const { source: candidate, target, code } of failures) {
    const directory = await workspace(candidate, renameRequest(candidate, target));
    assert.deepEqual(invoke(directory).response, { version: 1, ok: false, error: { code } });
    assert.deepEqual(await readFile(join(directory, 'input.pdf')), candidate);
  }
});
