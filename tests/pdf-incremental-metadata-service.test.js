import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfIncrementalMetadataService } from '../scripts/host/pdf-incremental-metadata-service.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { scheduleArtifactCleanup } from '../scripts/host/routes/artifact-response-lifecycle.mjs';
import { makeTextPdf } from './pdf-fixture.js';
import { MAX_INCREMENTAL_METADATA_SOURCE_BYTES } from '../scripts/host/pdf-incremental-metadata-validation.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const sourceBytes = Buffer.from(`%PDF-1.4\n${'stable source bytes '.repeat(8)}\nstartxref\n10\n%%EOF\n`);
const appended = Buffer.from(`\n${'incremental revision '.repeat(8)}\nstartxref\n200\n%%EOF\n`);
const outputBytes = Buffer.concat([sourceBytes, appended]);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const outputSha256 = createHash('sha256').update(outputBytes).digest('hex');
const metadata = Object.freeze({ title: 'Updated title', author: 'Updated author', subject: 'Updated subject', keywords: 'updated, keywords' });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(24).fill(0)]);

function makePageXmpPdf() {
  const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 5 0 R /Metadata 4 0 R >>',
    `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xml)} >>\nstream\n${xml}endstream`,
    '<< /Length 0 >>\nstream\nendstream',
  ];
  const chunks = ['%PDF-1.7\n']; const offsets = [];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 6\n0000000000 65535 f \n');
  offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

async function installedPopplerHarness(context) {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const required = ['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfdetach', 'pdfsig'];
  const availability = await Promise.allSettled(required.map((name) => registry.probe(name)));
  if (availability.some(({ status }) => status === 'rejected')) {
    context.skip('Required Poppler adapters are not installed.'); return null;
  }
  const root = await mkdtemp(join(tmpdir(), 'pdf-incremental-metadata-poppler-'));
  const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  return { store, poppler: new PopplerAdapter({ registry, runner }) };
}

function proof() {
  return Object.freeze({
    profile: 'local-classic-incremental-metadata-v1', sourceBytes: sourceBytes.length,
    outputBytes: outputBytes.length, appendedBytes: appended.length,
    sourcePrefixPreserved: true, priorObjectOffsetsPreserved: true, revisionCount: 2,
    previousXrefOffset: 10, appendedXrefOffset: sourceBytes.length + 20,
    infoObjectNumber: 20, infoGeneration: 0, effectiveSize: 21, rootPreserved: true,
    idPolicy: 'absent', metadataFieldCount: 4,
  });
}

function pdfInfo(output, sourceMatches) {
  const standard = output || sourceMatches
    ? `Title: ${metadata.title}\nAuthor: ${metadata.author}\nSubject: ${metadata.subject}\nKeywords: ${metadata.keywords}\n`
    : 'Title: Previous title\n';
  return `${standard}Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\n`;
}

function pageBoxes() {
  return [1, 2].map((page) => [
    `Page ${page} size: 612 x 792 pts`, `Page ${page} rot: 0`,
    `Page ${page} MediaBox: 0 0 612 792`, `Page ${page} CropBox: 0 0 612 792`,
  ].join('\n')).join('\n');
}

function signedOutput(input) {
  return [
    `Digital Signature Info of: ${input}`, 'Signature #1:',
    '  - Signing Hash Algorithm: SHA-256', '  - Signature Type: adbe.pkcs7.detached',
    '  - Signed Ranges: [0 - 20], [40 - 80]', '  - Total document signed',
    '  - Signature Validation: Signature is Valid.', '',
  ].join('\n');
}

async function fixture({
  sourceSigned = false, sourceXmp = '', outputXmp = '', outputCustom = 'Department: Archive\n',
  warningOperation = null, warningOnOutput = false, partialRenderFailure = false, sourceMatches = false,
  independentProof = proof(), cleanupFailureCall = null, mutateBeforePromotion = false,
  onExecute = null, sourceSize = sourceBytes.length, sourceSha = sourceSha256,
  mutateSourceAfterVerifiedStage = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-incremental-metadata-'));
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  let cleaned = 0; let verified = 0; let promoted = null; let deleted = null;
  let writerCalls = 0; let inspectorCalls = 0; const renderCalls = []; const cleanupEntries = [];
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha, size: sourceSize, displayName: 'source.pdf', mediaType: 'application/pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      verified += 1;
      if (verified === 2 && mutateSourceAfterVerifiedStage) {
        await mutateSourceAfterVerifiedStage({ sourcePath, sourceSha });
      }
      assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha);
    },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => { const call = ++cleaned; cleanupEntries.push(await readdir(path)); await rm(path, { recursive: true, force: true }); if (call === cleanupFailureCall) throw new Error('private cleanup failure'); },
    promotePdfArtifact: async (_id, path, options) => {
      if (mutateBeforePromotion) {
        const changed = await readFile(path); changed[changed.length - 1] ^= 1;
        await chmod(path, 0o600); await writeFile(path, changed); await chmod(path, 0o400);
      }
      const bytes = await readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== options.expectedSha256) {
        throw new Error('promoted bytes did not match the validated digest');
      }
      promoted = { bytes, options };
      return { id: artifactId, documentId, displayName: options.displayName, mediaType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), operation: options.operation, createdAt: new Date(0).toISOString() };
    },
    deleteArtifact: async (id) => { deleted = id; },
  };
  const poppler = { async execute(operation, parameters) {
    const output = parameters.input?.endsWith('output.pdf') ?? false;
    const stderr = operation === warningOperation && (!warningOnOutput || output) ? 'Syntax Warning: repaired PDF\n' : '';
    if (onExecute) await onExecute({ operation, parameters });
    if (operation === 'inspect') return { stdout: pdfInfo(output, sourceMatches), stderr };
    if (operation === 'inspectMetadata') return { stdout: output ? outputXmp : sourceXmp, stderr };
    if (operation === 'inspectCustomMetadata') return { stdout: output ? outputCustom : 'Department: Archive\n', stderr };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr };
    if (operation === 'inspectPageBoxes') return { stdout: pageBoxes(), stderr };
    if (operation === 'extractText') return { stdout: 'first page\fsecond page\f', stderr };
    if (operation === 'verifySignatures') return { stdout: sourceSigned && !output ? signedOutput(parameters.input) : `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'renderPagePng') { renderCalls.push({ ...parameters }); await writeFile(`${parameters.outputPrefix}.png`, png, { mode: 0o600 }); if (partialRenderFailure && renderCalls.length === 1) throw new Error('partial render failure'); return { stdout: '', stderr }; }
    assert.fail(`unexpected Poppler operation ${operation}`);
  } };
  const core = {
    normalizeIncrementalMetadata: (value) => Object.freeze({ title: value.title, author: value.author, subject: value.subject, keywords: value.keywords }),
    writeIncrementalPdfMetadata: (bytes, value) => { writerCalls += 1; assert(bytes.equals(sourceBytes)); assert.deepEqual(value, metadata); return Object.freeze({ bytes: Buffer.from(outputBytes), proof: proof() }); },
    inspectIncrementalPdfMetadata: (source, output, value) => { inspectorCalls += 1; assert(source.equals(sourceBytes)); assert(output.equals(outputBytes)); assert.deepEqual(value, metadata); return independentProof; },
  };
  return {
    root, sourcePath, service: new PdfIncrementalMetadataService({ store, poppler, core }),
    state: () => ({ cleaned, verified, promoted, deleted, writerCalls, inspectorCalls, renderCalls, cleanupEntries }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('incremental metadata service proves the prefix and promotes only a fully bound artifact', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const result = await setup.service.update(documentId, metadata, { sourceSha256 });
  assert.equal(result.kind, 'pdf-incremental-metadata'); assert.equal(result.artifact.sha256, outputSha256);
  assert.deepEqual(result.metadata.updatedFields, ['title', 'author', 'subject', 'keywords']);
  assert.deepEqual(Object.keys(result.evidence), ['sourceDigestReverified', 'sourcePrefixPreserved', 'priorObjectOffsetsPreserved', 'rootReferencePreserved', 'freshInfoObjectAllocated', 'classicIncrementalRevisionAppended', 'popplerMetadataMatched', 'pageCountMatched', 'pageTextMatched', 'pageGeometryMatched', 'pageRendersMatched', 'outputUnsigned', 'xmpAbsent', 'artifactDigestBound', 'sourceUnchanged', 'localOnly']);
  assert.equal(result.limitations.length, 3); assert.doesNotMatch(JSON.stringify(result), /Updated title|Updated author|Updated subject|updated, keywords/);
  const state = setup.state(); assert(state.promoted.bytes.subarray(0, sourceBytes.length).equals(sourceBytes));
  assert.equal(state.promoted.options.operation.type, 'pdf-incremental-metadata');
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, { profile: 'local-classic-incremental-metadata-v1', updatedFields: ['title', 'author', 'subject', 'keywords'] });
  assert.deepEqual({ ...state.promoted.options.operation.expected }, { pageCount: 2, sourceUnchanged: true, sourcePrefixPreserved: true, rasterized: false });
  assert.equal(state.writerCalls, 1); assert.equal(state.inspectorCalls, 1); assert.equal(state.renderCalls.length, 4);
  assert.equal(state.verified, 2); assert.equal(state.cleaned, 2); assert.equal(state.deleted, null);
});

test('incremental metadata service rejects stale digests, signatures, and XMP before writing', async (context) => {
  const stale = await fixture(); context.after(stale.dispose);
  await assert.rejects(stale.service.update(documentId, metadata, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  assert.equal(stale.state().writerCalls, 0); assert.equal(stale.state().cleaned, 0);
  for (const options of [{ sourceSigned: true }, { sourceXmp: '<x:xmpmeta />' }]) {
    const setup = await fixture(options); context.after(setup.dispose);
    await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), { code: 'INCREMENTAL_METADATA_SOURCE_UNSUPPORTED', status: 422 });
    assert.equal(setup.state().writerCalls, 0); assert.equal(setup.state().cleaned, 2); assert.equal(setup.state().promoted, null);
  }
});

test('incremental metadata service enforces source bounds before staging and promotion', async (context) => {
  const setup = await fixture({ sourceSize: MAX_INCREMENTAL_METADATA_SOURCE_BYTES + 1 }); context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), {
    code: 'INCREMENTAL_METADATA_INPUT_TOO_LARGE', status: 413,
  });
  const state = setup.state();
  assert.equal(state.promoted, null);
  assert.equal(state.writerCalls, 0);
  assert.equal(state.inspectorCalls, 0);
  assert.equal(state.renderCalls.length, 0);
  assert.equal(state.verified, 0);
  assert.equal(state.cleaned, 0);
});

test('incremental metadata service rejects drifted source after private staging without artifact promotion', async (context) => {
  const setup = await fixture({
    mutateSourceAfterVerifiedStage: async ({ sourcePath: stagedSource }) => {
      await writeFile(stagedSource, '%PDF-1.4\nmutated after staging\n%%EOF\n', 'latin1');
    },
  });
  context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), {
    code: 'INCREMENTAL_METADATA_FAILED', status: 502,
  });
  const state = setup.state();
  assert.equal(state.promoted, null);
  assert.equal(state.deleted, null);
  assert.equal(state.writerCalls, 1);
  assert.equal(state.inspectorCalls, 1);
  assert.equal(state.verified, 2);
  assert.equal(state.renderCalls.length, 4);
  assert.equal(state.cleaned, 2);
  assert.equal(state.cleanupEntries.flat().some((name) => name.endsWith('.png')), false);
});

test('incremental metadata service cancels in-flight work with workspace cleanup and without promotion', async (context) => {
  const controller = new AbortController();
  let aborted = false;
  const setup = await fixture({
    onExecute: ({ operation }) => {
      if (operation === 'renderPagePng' && !aborted) {
        aborted = true;
        controller.abort(new Error('cancelled'));
      }
    },
  }); context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256, signal: controller.signal }), {
    code: 'JOB_CANCELLED',
    status: 499,
  });
  const state = setup.state();
  assert.equal(state.promoted, null);
  assert.equal(state.deleted, null);
  assert.equal(state.writerCalls, 1);
  assert.equal(state.inspectorCalls, 1);
  assert.equal(state.renderCalls.length, 4);
  assert.equal(state.cleaned, 2);
  assert.equal(state.cleanupEntries.flat().some((name) => name.endsWith('.png')), false);
});

test('incremental metadata service rejects a semantic no-op before raw writing', async (context) => {
  const setup = await fixture({ sourceMatches: true }); context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), {
    code: 'INVALID_INCREMENTAL_METADATA_OPTIONS', status: 400,
  });
  const state = setup.state();
  assert.equal(state.writerCalls, 0); assert.equal(state.promoted, null); assert.equal(state.cleaned, 2);
});

test('incremental metadata service rejects proof and custom metadata disagreement without promotion', async (context) => {
  const cases = [
    { independentProof: Object.freeze({ ...proof(), sourcePrefixPreserved: false }) },
    { outputCustom: 'Department: Changed\n' },
  ];
  for (const options of cases) {
    const setup = await fixture(options); context.after(setup.dispose);
    await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }));
    const state = setup.state(); assert.equal(state.promoted, null); assert.equal(state.cleaned, 2);
  }
});

test('incremental metadata service binds promotion to the exact raw-inspected buffer digest', async (context) => {
  const setup = await fixture({ mutateBeforePromotion: true }); context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), {
    code: 'INCREMENTAL_METADATA_FAILED', status: 502,
  });
  const state = setup.state(); assert.equal(state.promoted, null); assert.equal(state.cleaned, 2); assert.equal(state.deleted, null);
});

test('incremental metadata service rejects stderr from every Poppler evidence operation before and after writing', async (context) => {
  const operations = ['inspect', 'inspectMetadata', 'inspectCustomMetadata', 'listAttachments', 'inspectUrls', 'inspectPageBoxes', 'extractText', 'renderPagePng'];
  for (const warningOperation of operations) for (const warningOnOutput of [false, true]) {
    const setup = await fixture({ warningOperation, warningOnOutput }); context.after(setup.dispose);
    await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), { code: 'INCREMENTAL_METADATA_POPPLER_WARNING' });
    const state = setup.state(); assert.equal(state.promoted, null); assert.equal(state.cleaned, 2);
    assert.equal(state.cleanupEntries.flat().some((name) => name.endsWith('.png')), false);
  }
});

test('incremental metadata service removes a partially rendered PNG before rollback cleanup', async (context) => {
  const setup = await fixture({ partialRenderFailure: true }); context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), { code: 'INCREMENTAL_METADATA_FAILED' });
  assert.equal(setup.state().cleanupEntries.flat().some((name) => name.endsWith('.png')), false);
});

test('incremental metadata service revokes promotion when private cleanup fails', async (context) => {
  const setup = await fixture({ cleanupFailureCall: 1 }); context.after(setup.dispose);
  await assert.rejects(setup.service.update(documentId, metadata, { sourceSha256 }), { code: 'INCREMENTAL_METADATA_CLEANUP_FAILED', status: 500 });
  const state = setup.state(); assert.notEqual(state.promoted, null); assert.equal(state.deleted, artifactId); assert.equal(state.cleaned, 2);
});

test('artifact response lifecycle revokes an incremental result on disconnect before delivery', async () => {
  const response = new EventEmitter(); response.destroyed = false;
  const controller = new AbortController(); const deleted = [];
  const store = { deleteArtifact: async (id) => { deleted.push(id); } };
  assert.equal(await scheduleArtifactCleanup({ processing: { signal: controller.signal }, response, store }, artifactId), false);
  response.emit('close'); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, [artifactId]);
  controller.abort();
  assert.equal(await scheduleArtifactCleanup({ processing: { signal: controller.signal }, response, store }, 'aborted-artifact'), true);
  assert.deepEqual(deleted, [artifactId, 'aborted-artifact']);
  await assert.rejects(
    scheduleArtifactCleanup({
      processing: { signal: controller.signal }, response,
      store: { deleteArtifact: async () => { throw new Error('cleanup failed'); } },
    }, 'failed-artifact'),
    /cleanup failed/,
  );
});

test('installed Poppler independently reopens a real append-only metadata artifact', async (context) => {
  const harness = await installedPopplerHarness(context); if (!harness) return;
  const { store, poppler } = harness;
  const source = makeTextPdf('Incremental metadata Poppler integration');
  const document = await store.createDocument({ stream: Readable.from([source]), displayName: 'integration.pdf' });
  const service = new PdfIncrementalMetadataService({ store, poppler });
  const requested = { title: 'Integrated title', author: 'Integrated author', subject: 'Integrated subject', keywords: 'integrated, metadata' };
  const result = await service.update(document.id, requested, { sourceSha256: document.sha256 });
  const artifactBytes = await readFile(store.getArtifact(result.artifact.id).filePath);
  assert(artifactBytes.subarray(0, source.length).equals(source));
  assert.equal(createHash('sha256').update(artifactBytes).digest('hex'), result.artifact.sha256);
  assert((await readFile(store.getSourcePath(document.id))).equals(source));
  assert.equal(result.evidence.pageRendersMatched, true); assert.equal(result.evidence.outputUnsigned, true);
});

test('real service rejects page-level XMP that Poppler metadata output does not expose', async (context) => {
  const harness = await installedPopplerHarness(context); if (!harness) return;
  const { store, poppler } = harness;
  const source = makePageXmpPdf();
  const document = await store.createDocument({ stream: Readable.from([source]), displayName: 'page-xmp.pdf' });
  const service = new PdfIncrementalMetadataService({ store, poppler });
  await assert.rejects(service.update(document.id, metadata, { sourceSha256: document.sha256 }), {
    code: 'INCREMENTAL_METADATA_SOURCE_UNSUPPORTED', status: 422,
  });
  assert((await readFile(store.getSourcePath(document.id))).equals(source));
  assert.deepEqual(await readdir(join(store.root, 'artifacts')), []);
});
