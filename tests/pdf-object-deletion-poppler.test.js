import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  authorizePdfObjectDeletion,
  planPdfObjectDeletionTransaction,
} from '../scripts/host/pdf-classic-object-transaction.mjs';
import {
  verifyPdfDeletionIncrementalRevision,
} from '../scripts/host/pdf-incremental-deletion-revision.mjs';
import {
  parsePdfStructure,
  resolvePdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';
import {
  deletionRequest,
  dict,
  ref,
  validXrefStreamSource,
} from './support/pdf-object-deletion-fixture.js';

const execFileAsync = promisify(execFile);

test('installed Poppler inspects and renders a logical-deletion append', async (context) => {
  const pdfinfo = '/opt/homebrew/bin/pdfinfo';
  const pdftocairo = '/opt/homebrew/bin/pdftocairo';
  try {
    await Promise.all([pdfinfo, pdftocairo].map((path) => access(path)));
  } catch {
    context.skip('The fixed Poppler inspection tools are unavailable.');
    return;
  }
  const source = validXrefStreamSource();
  const structure = parsePdfStructure(source);
  const page = resolvePdfObject(structure, ref(5)).value;
  const updatedPage = dict([...page.entries].filter(([key]) => key !== 'Contents'));
  const plan = planPdfObjectDeletionTransaction(deletionRequest(
    source,
    structure,
    [authorizePdfObjectDeletion(structure, ref(6))],
    { updates: [{ reference: ref(5), value: updatedPage }] },
  ));
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const proof = verifyPdfDeletionIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  assert.equal(proof.freeListVerified, true);

  const directory = await mkdtemp(join(tmpdir(), 'pdf-deletion-poppler-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'output.pdf');
  const rasterPrefix = join(directory, 'render');
  await writeFile(outputPath, outputBytes);
  const { stdout } = await execFileAsync(pdfinfo, [outputPath]);
  assert.match(stdout, /^Pages:\s+1$/mu);
  await execFileAsync(pdftocairo, [
    '-f', '1', '-l', '1', '-singlefile', '-png', '-r', '36',
    outputPath, rasterPrefix,
  ]);
  await access(`${rasterPrefix}.png`);
});
