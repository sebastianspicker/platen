import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfAnnotationFlattenService } from '../scripts/host/pdf-annotation-flatten-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function makeProof(source, output, changes = {}) {
  return Object.freeze({
    profile: 'local-square-annotation-flatten-v1', sourceBytes: source.length,
    outputBytes: output.length, sourceSha256: sha(source), outputSha256: sha(output),
    sourcePrefixPreserved: false, closedClassicRevision: true,
    priorRevisionsAbsent: true, revisionCount: 1, annotationRemoved: true,
    removedReferenceUnresolvable: true, appearancePreserved: true,
    appearancePromotedToPageContent: true, rootPreserved: true, infoPreserved: true,
    idPolicy: 'absent', ...changes,
  });
}

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'annotation-flatten-service-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from(`%PDF-1.7\n${'square annotation '.repeat(12)}\n%%EOF\n`);
  const output = Buffer.from(`%PDF-1.7\n${'square flattened '.repeat(12)}\n%%EOF\n`);
  const digest = sha(source); const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const observed = { promoted: 0, deleted: [], workspaces: [], outputSwapped: false };
  const controller = options.controller ?? new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256: digest, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(sha(await readFile(sourcePath)), digest),
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces.push(path); return path; },
    cleanupJob: async (path) => {
      await rm(path, { recursive: true, force: true });
      if (options.cleanupFailure) throw new Error('cleanup failure');
    },
    promotePdfArtifact: async (_id, _path, promotion) => {
      observed.promoted += 1;
      if (options.abortAfterPromotion) controller.abort(new Error('cancelled after promotion'));
      return { id: '22222222-2222-4222-8222-222222222222', sha256: promotion.expectedSha256, operation: promotion.operation };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const info = (mismatch = false) => `Pages: 1\n${mismatch ? 'Title: changed\n' : ''}Encrypted: no\nForm: none\nJavaScript: no\nTagged: no\n`;
  const poppler = { execute: async (operation, parameters) => {
    const outputFile = String(parameters.input ?? '').endsWith('output.pdf');
    if (operation === 'inspect') return { stdout: info(outputFile && options.envelopeMismatch), stderr: '' };
    if (['inspectMetadata', 'inspectCustomMetadata'].includes(operation)) return { stdout: '', stderr: '' };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: '' };
    if (operation === 'extractText') return { stdout: 'fixture\f', stderr: '' };
    if (operation === 'renderPagePng') { if (options.swapOutput && outputFile && !observed.outputSwapped) { await unlink(parameters.input); await writeFile(parameters.input, output, { mode: 0o400 }); observed.outputSwapped = true; } await writeFile(`${parameters.outputPrefix}.png`, options.renderMismatch && outputFile ? Buffer.concat([png, Buffer.from('x')]) : png); return { stdout: '', stderr: '' }; }
    assert.fail(operation);
  } };
  const request = Object.freeze({ profile: 'local-square-annotation-flatten-v1', sourceSha256: digest, target: Object.freeze({ page: 1, annotationIndex: 0, fingerprint: 'a'.repeat(64), subtype: 'square' }) });
  const exact = makeProof(source, output);
  const core = {
    normalizePdfAnnotationFlatten: (value) => value,
    writePdfAnnotationFlatten: (input) => options.overlap ? { bytes: input, proof: exact } : { bytes: Buffer.from(output), proof: options.badProof ? makeProof(source, output, { appearancePreserved: false }) : exact },
    inspectPdfAnnotationFlatten: (_input, bytes) => options.inspectorMismatch ? makeProof(source, bytes, { revisionCount: 2 }) : exact,
  };
  return { service: new PdfAnnotationFlattenService({ store, poppler, core }), digest, request, observed, controller };
}

test('annotation-flatten service stages, reinspects, renders, and promotes only the verified compact artifact', async (context) => {
  const setup = await fixture(context);
  const result = await setup.service.flatten(documentId, setup.request, { sourceSha256: setup.digest });
  assert.equal(setup.observed.promoted, 1);
  assert.equal(result.kind, 'pdf-square-annotation-flatten');
  assert.deepEqual(result.flatten, { profile: setup.request.profile, page: 1, annotationIndex: 0, subtype: 'square' });
  assert.equal(result.evidence.appearancePromotedToPageContent, true);
  assert.deepEqual(setup.observed.deleted, []);
  await Promise.all(setup.observed.workspaces.map((path) => assert.rejects(readFile(path))));
});

test('annotation-flatten service rejects source, raw proof, reinspection, workspace identity, and Poppler equivalence failures', async (context) => {
  const stale = await fixture(context);
  await assert.rejects(stale.service.flatten(documentId, stale.request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.equal(stale.observed.workspaces.length, 0);
  for (const [options, code] of [[{ overlap: true }, 'PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID'], [{ badProof: true }, 'PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID'], [{ inspectorMismatch: true }, 'PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID'], [{ swapOutput: true }, 'PDF_ANNOTATION_FLATTEN_WORKSPACE_INVALID'], [{ envelopeMismatch: true }, 'PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID'], [{ renderMismatch: true }, 'PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID']]) {
    const setup = await fixture(context, options);
    await assert.rejects(setup.service.flatten(documentId, setup.request, { sourceSha256: setup.digest }), { code });
    assert.equal(setup.observed.promoted, 0);
  }
});

test('annotation-flatten service revokes a promoted artifact after cancellation or cleanup failure', async (context) => {
  const cancelled = await fixture(context, { abortAfterPromotion: true });
  await assert.rejects(cancelled.service.flatten(documentId, cancelled.request, {
    sourceSha256: cancelled.digest, signal: cancelled.controller.signal,
  }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.observed.deleted, ['22222222-2222-4222-8222-222222222222']);

  const cleanup = await fixture(context, { cleanupFailure: true });
  await assert.rejects(cleanup.service.flatten(documentId, cleanup.request, {
    sourceSha256: cleanup.digest,
  }), { code: 'PDF_ANNOTATION_FLATTEN_CLEANUP_FAILED' });
  assert.deepEqual(cleanup.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});
