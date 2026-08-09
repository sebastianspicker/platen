import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { handleOoxmlExportRoute } from '../scripts/host/routes/ooxml-export-routes.mjs';
import { runOoxmlExportCommand } from '../scripts/cli/commands/ooxml-export.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runSnapshotRegionCommand } from '../scripts/cli/commands/snapshot-region.mjs';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';
import { decodePng } from '../scripts/host/raster-png-codec.mjs';
import { createR02SourceFixture } from './support/r02-existing-authority-fixtures.js';

const FORMATS = Object.freeze({
  word: Object.freeze({ extension: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  excel: Object.freeze({ extension: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  powerpoint: Object.freeze({ extension: 'pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
});

function outputEntries(format, bytes) {
  const entries = readZipEntries(bytes);
  const required = format === 'word'
    ? ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
    : format === 'excel'
      ? ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']
      : ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml'];
  for (const name of required) assert.equal(entries.has(name), true, `${format} missing ${name}`);
  return entries;
}

async function runCliWithRealStore(fixture, format) {
  const output = join(fixture.root, `published.${FORMATS[format].extension}`);
  let receipt;
  await runOoxmlExportCommand(
    { ooxmlExport: fixture.ooxmlExport, store: fixture.store },
    { format, output },
    fixture.source,
    null,
    undefined,
    {
      cancelled() {},
      canonicalOutputTarget: async () => {},
      copyExclusive: async (source, target) => writeFile(target, await readFile(source), { flag: 'wx', mode: 0o600 }),
      emit: async (_stdout, value) => { receipt = value; },
    },
  );
  return { output, receipt };
}

test('R02 OOXML claims use the real source-bound service, retained ZIP artifacts, route, and CLI for all formats', async (t) => {
  const fixture = await createR02SourceFixture();
  t.after(() => fixture.dispose());
  for (const format of Object.keys(FORMATS)) {
    const result = await fixture.ooxmlExport.export(fixture.source.id, format, {
      sourceSha256: fixture.source.sha256,
    });
    assert.equal(result.sourceDigest, fixture.source.sha256);
    assert.equal(result.pageCount, 2);
    const artifact = fixture.store.getArtifact(result.artifact.id);
    const retained = await readFile(artifact.filePath);
    assert.equal(artifact.documentId, fixture.source.id);
    assert.equal(artifact.mediaType, FORMATS[format].mediaType);
    assert.equal(artifact.sha256, result.artifact.sha256);
    assert.equal(artifact.size, retained.length);
    outputEntries(format, retained);
    await fixture.store.deleteArtifact(artifact.id);

    const response = {};
    const routeResult = await handleOoxmlExportRoute({
      pathname: `/api/documents/${fixture.source.id}/export-ooxml`,
      request: { method: 'POST' }, response, documentId: fixture.source.id,
      ooxmlExport: fixture.ooxmlExport,
      processing: { signal: new AbortController().signal },
      method: (request, expected) => assert.equal(request.method, expected),
      readJson: async () => ({ profile: 'local-pdf-ooxml-export-v1', sourceSha256: fixture.source.sha256, format }),
      bodyLimit: 32_768,
      exactJsonObject: (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
      json: (target, status, value) => { target.status = status; target.body = value; },
    });
    assert.equal(routeResult, true);
    assert.equal(response.status, 201);
    assert.equal(Object.hasOwn(response.body.result, 'bytes'), false);
    await fixture.store.deleteArtifact(response.body.result.artifact.id);

    const cli = await runCliWithRealStore(fixture, format);
    assert.equal(cli.receipt.kind, 'pdf-ooxml-export');
    assert.equal(cli.receipt.format, format);
    assert.equal(cli.receipt.sourceDigest, fixture.source.sha256);
    assert.equal((await stat(cli.output)).mode & 0o777, 0o600);
    outputEntries(format, await readFile(cli.output));
  }
});

test('R02 OOXML source binding rejects digest mismatch, cancellation, and source tampering', async (t) => {
  const fixture = await createR02SourceFixture();
  t.after(() => fixture.dispose());
  await assert.rejects(
    fixture.ooxmlExport.export(fixture.source.id, 'word', { sourceSha256: '0'.repeat(64) }),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    fixture.ooxmlExport.export(fixture.source.id, 'excel', { sourceSha256: fixture.source.sha256, signal: controller.signal }),
    { message: 'cancelled' },
  );
  await writeFile(fixture.store.getSourcePath(fixture.source.id), Buffer.from('%PDF-1.7\ntampered'));
  await assert.rejects(
    fixture.ooxmlExport.export(fixture.source.id, 'powerpoint', { sourceSha256: fixture.source.sha256 }),
    { code: 'SOURCE_INTEGRITY_FAILED' },
  );
});

test('R02 OOXML CLI refuses a forged foreign-document artifact without deleting it', async (t) => {
  const fixture = await createR02SourceFixture();
  t.after(() => fixture.dispose());
  const legitimate = await fixture.ooxmlExport.export(fixture.source.id, 'word', { sourceSha256: fixture.source.sha256 });
  const forged = {
    ...legitimate,
    artifact: { ...legitimate.artifact, documentId: '99999999-9999-4999-8999-999999999999' },
  };
  const output = join(fixture.root, 'forged.docx');
  await assert.rejects(
    runOoxmlExportCommand(
      { ooxmlExport: { export: async () => forged }, store: fixture.store },
      { format: 'word', output }, fixture.source, null, undefined,
      { cancelled() {}, canonicalOutputTarget: async () => {}, copyExclusive: async () => { throw new Error('must not copy'); }, emit: async () => {} },
    ),
    { code: 'CLI_OOXML_ARTIFACT_INVALID' },
  );
  assert.equal(fixture.store.getArtifact(legitimate.artifact.id).id, legitimate.artifact.id);
  await fixture.store.deleteArtifact(legitimate.artifact.id);
});

test('R02 selected-region claim uses the shipped Poppler snapshot command with source verification and exact publication rollback', async (t) => {
  const fixture = await createR02SourceFixture();
  t.after(() => fixture.dispose());
  const output = join(fixture.root, 'selected.png');
  const command = parseCliArguments([
    'snapshot-region', fixture.store.getSourcePath(fixture.source.id), '--page', '1',
    '--region', '0,0,0.5,0.5', '--dpi', '72', '--output', output,
  ]);
  let receipt;
  await runSnapshotRegionCommand(
    { service: fixture.service },
    command,
    fixture.source,
    null,
    undefined,
    {
      cancelled() {},
      canonicalOutputTarget: async () => {},
      writeExclusive: async (target, bytes) => writeFile(target, bytes, { flag: 'wx', mode: 0o600 }),
      emit: async (_stdout, value) => { receipt = value; },
    },
  );
  const published = await readFile(output);
  const image = decodePng(published);
  assert.equal(published.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(image.width > 0 && image.height > 0);
  assert.deepEqual(receipt, {
    kind: 'cropbox-snapshot', sourceSha256: fixture.source.sha256, page: 1, dpi: 72,
    region: command.region, bytes: published.length, localOnly: true,
  });

  const cancelledOutput = join(fixture.root, 'cancelled.png');
  await assert.rejects(
    runSnapshotRegionCommand(
      { service: fixture.service },
      { ...command, output: cancelledOutput },
      fixture.source,
      null,
      undefined,
      {
        cancelled() {},
        canonicalOutputTarget: async () => {},
        writeExclusive: async () => { const error = new Error('cancelled during publication'); error.code = 'JOB_CANCELLED'; throw error; },
        emit: async () => { throw new Error('receipt must not be emitted'); },
      },
    ),
    { code: 'JOB_CANCELLED' },
  );
  await assert.rejects(readFile(cancelledOutput));
});
