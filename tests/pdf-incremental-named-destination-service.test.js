import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfIncrementalNamedDestinationService } from '../scripts/host/pdf-incremental-named-destination-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const request = Object.freeze({ profile: 'local-incremental-named-destination-v1', targetPage: 1, name: 'chapter-1' });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function proof(source, output) {
  return Object.freeze({
    profile: request.profile, sourceBytes: source.length, outputBytes: output.length,
    sourcePrefixPreserved: true, revisionCount: 2, previousXrefOffset: 10,
    appendedXrefOffset: source.length, targetPage: 1, targetPageObjectNumber: 3,
    targetPageGeneration: 0, nameSha256: createHash('sha256').update(request.name, 'ascii').digest('hex'),
    effectiveSize: 5, rootPreserved: true, infoPreserved: true, idPolicy: 'absent',
  });
}

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'named-destination-service-negative-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from(`%PDF-1.4\n${'source '.repeat(20)}\nstartxref\n10\n%%EOF\n`);
  const output = Buffer.concat([source, Buffer.from('append '.repeat(20))]);
  const digest = createHash('sha256').update(source).digest('hex');
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const expectedProof = proof(source, output);
  const controller = options.controller ?? new AbortController();
  const observed = { deleted: [], promoted: 0, workspaces: 0, sourceChecks: 0, outputSwapped: false };
  const store = {
    getDocument: () => ({ id: documentId, sha256: digest, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      observed.sourceChecks += 1;
      if (options.swapSourceOnRecheck && observed.sourceChecks === 2) await writeFile(sourcePath, Buffer.concat([source, Buffer.from('swapped')]), { mode: 0o600 });
      assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), digest);
    },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces += 1; return path; },
    cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); if (options.cleanupFailure) throw new Error('cleanup failure'); },
    promotePdfArtifact: async (_id, _path, promotion) => {
      observed.promoted += 1;
      if (options.abortAfterPromotion) controller.abort(new Error('cancelled after promotion'));
      return { id: artifactId, sha256: promotion.expectedSha256, displayName: 'named-destination.pdf', operation: promotion.operation };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const poppler = { execute: async (operation, parameters) => {
    const isOutput = String(parameters.input ?? '').endsWith('output.pdf');
    if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n', stderr: '' };
    if (['inspectMetadata', 'inspectCustomMetadata'].includes(operation)) return { stdout: '', stderr: '' };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'inspectDestinations') return { stdout: isOutput ? `Page  Destination                 Name\n1 [ Fit                     ] "${request.name}"\n` : 'Page  Destination                 Name\n', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: '' };
    if (operation === 'extractText') return { stdout: options.contentMismatch && isOutput ? 'changed\f' : 'fixture\f', stderr: '' };
    if (operation === 'renderPagePng') {
      if (options.swapOutput && isOutput && !observed.outputSwapped) {
        await unlink(parameters.input); await writeFile(parameters.input, output, { mode: 0o400 }); observed.outputSwapped = true;
      }
      await writeFile(`${parameters.outputPrefix}.png`, options.renderMismatch && isOutput ? Buffer.concat([png, Buffer.from('x')]) : png);
      return { stdout: '', stderr: '' };
    }
    assert.fail(operation);
  } };
  const core = {
    normalizeIncrementalNamedDestination: (value) => value,
    writeIncrementalPdfNamedDestination: (input) => options.overlap ? { bytes: input, proof: expectedProof } : { bytes: Buffer.from(output), proof: expectedProof },
    inspectIncrementalPdfNamedDestination: () => options.proofMismatch ? { ...expectedProof, effectiveSize: 6 } : expectedProof,
  };
  return { service: new PdfIncrementalNamedDestinationService({ store, poppler, core }), digest, controller, observed };
}

test('named-destination service rejects writer overlap and proof disagreement before promotion', async (context) => {
  for (const [options, code] of [
    [{ overlap: true }, 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID'],
    [{ proofMismatch: true }, 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID'],
  ]) {
    const setup = await fixture(context, options);
    await assert.rejects(setup.service.update(documentId, request, { sourceSha256: setup.digest }), { code });
    assert.equal(setup.observed.promoted, 0);
  }
});

test('named-destination service rejects Poppler content, render, and output-identity disagreement before promotion', async (context) => {
  for (const [options, code] of [
    [{ contentMismatch: true }, 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID'],
    [{ renderMismatch: true }, 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID'],
    [{ swapOutput: true }, 'INCREMENTAL_NAMED_DESTINATION_WORKSPACE_INVALID'],
  ]) {
    const setup = await fixture(context, options);
    await assert.rejects(setup.service.update(documentId, request, { sourceSha256: setup.digest }), { code });
    assert.equal(setup.observed.promoted, 0);
  }
});

test('named-destination service rechecks immutable source bytes before promotion', async (context) => {
  const setup = await fixture(context, { swapSourceOnRecheck: true });
  await assert.rejects(setup.service.update(documentId, request, { sourceSha256: setup.digest }), { code: 'INCREMENTAL_NAMED_DESTINATION_FAILED' });
  assert.equal(setup.observed.sourceChecks, 2);
  assert.equal(setup.observed.promoted, 0);
});

test('named-destination service revokes promotion after cancellation and cleanup failure', async (context) => {
  const cancelled = await fixture(context, { abortAfterPromotion: true });
  await assert.rejects(cancelled.service.update(documentId, request, { sourceSha256: cancelled.digest, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.observed.deleted, [artifactId]);
  const cleanup = await fixture(context, { cleanupFailure: true });
  await assert.rejects(cleanup.service.update(documentId, request, { sourceSha256: cleanup.digest }), { code: 'INCREMENTAL_NAMED_DESTINATION_CLEANUP_FAILED' });
  assert.deepEqual(cleanup.observed.deleted, [artifactId]);
});
