import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { runScanAppendCommand } from '../scripts/cli/commands/scan-append.mjs';
import * as cliRuntime from '../scripts/cli/runtime.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';

const POPPLER_TOOLS = ['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/pdfsig'];

test('scan-append integrates ImageMagick conversion and Poppler copy-page with complete temporary cleanup', async (context) => {
  try { await Promise.all([...POPPLER_TOOLS, '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch { context.skip('Installed ImageMagick and Poppler tools are required for the scan append integration gate.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'platen-scan-append-integration-'));
  const inputPath = join(root, 'scan.png'); const outputPath = join(root, 'appended.pdf');
  const image = encodeRgbaPng({ width: 2, height: 2, pixels: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) });
  await writeFile(inputPath, image, { mode: 0o600 });
  let application;
  try {
    application = await createLocalApplication({ root: process.cwd(), token: 'd'.repeat(64) });
    const primary = await application.store.createDocument({ stream: (async function* () { yield makeMultiPagePdf(['First', 'Second']); }()), displayName: 'primary.pdf' });
    const primaryPath = application.store.getSourcePath(primary.id); const before = await readFile(primaryPath);
    const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await runScanAppendCommand(application, { command: 'scan-append', input: 'primary.pdf', scan: inputPath, extension: '.png', afterPage: 1, output: outputPath }, primary, stdout, undefined, cliRuntime);
    const output = await readFile(outputPath); assert.match(output.toString('latin1', 0, 8), /^%PDF-/u);
    const derived = await application.store.createDocument({ stream: createReadStream(outputPath), displayName: 'appended.pdf' });
    try {
      const inspection = await application.service.inspect(derived.id); assert.equal(inspection.pageCount, 3);
      const pages = await application.service.extractText(derived.id, inspection.pageCount);
      assert.deepEqual(pages.map(({ text }) => text.trim()), ['First', '', 'Second']);
    } finally { await application.store.deleteDocument(derived.id); }
    assert.deepEqual(await readFile(primaryPath), before);
    assert.deepEqual(await readdir(join(application.store.root, 'inputs')), []);
    assert.deepEqual(await readdir(join(application.store.root, 'artifacts')), []);
    assert.deepEqual(await readdir(join(application.store.root, 'documents')), [primary.id]);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes('.partial') || name.includes('platen-')), []);
  } finally { await application?.close?.(); await rm(root, { recursive: true, force: true }); }
});
