import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';

function storeRoot() {
  return mkdtempSync(join(tmpdir(), 'platen-store-test-'));
}

const minimalPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const minimalPdfDigest = createHash('sha256').update(minimalPdf).digest('hex');

test('document store retains an immutable, private source with an opaque identifier', async (context) => {
  const store = await new DocumentStore({ root: storeRoot() }).initialize();
  context.after(() => store.dispose());

  const record = await store.createDocument({
    stream: Readable.from([minimalPdf.subarray(0, 8), minimalPdf.subarray(8)]),
    displayName: '../unsafe\\report.pdf',
  });

  assert.match(record.id, /^[0-9a-f-]{36}$/i);
  assert.equal(record.displayName, 'report.pdf');
  assert.equal(record.size, minimalPdf.length);
  assert.equal(record.origin, 'uploaded');
  assert.equal(record.operation, null);
  assert.deepEqual(readFileSync(store.getSourcePath(record.id)), minimalPdf);
  assert.equal(await store.verifySource(record.id), true);
  assert.equal(Object.isFrozen(record), true);
});

test('document store rejects invalid and oversized uploads without residue', async (context) => {
  const root = storeRoot();
  const store = await new DocumentStore({ root, maxBytes: 12 }).initialize();
  context.after(() => store.dispose());

  await assert.rejects(
    store.createDocument({ stream: Readable.from([Buffer.from('not a pdf')]), displayName: 'bad.pdf' }),
    { code: 'INVALID_PDF_HEADER', status: 400 },
  );
  await assert.rejects(
    store.createDocument({ stream: Readable.from([minimalPdf]), displayName: 'large.pdf' }),
    { code: 'FILE_TOO_LARGE', status: 413 },
  );
  assert.equal(existsSync(join(root, 'documents')), true);
});

test('document deletion removes the source and makes its handle unusable', async (context) => {
  const store = await new DocumentStore({ root: storeRoot() }).initialize();
  context.after(() => store.dispose());
  const record = await store.createDocument({ stream: Readable.from([minimalPdf]), displayName: 'source.pdf' });
  const sourcePath = store.getSourcePath(record.id);

  await store.deleteDocument(record.id);

  assert.equal(existsSync(sourcePath), false);
  assert.throws(() => store.getDocument(record.id), { code: 'DOCUMENT_NOT_FOUND', status: 404 });
});

test('artifact promotion requires validated versioned provenance tied to its source', async (context) => {
  const root = storeRoot();
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const record = await store.createDocument({ stream: Readable.from([minimalPdf]), displayName: 'source.pdf' });
  const output = join(root, 'derived.pdf');
  writeFileSync(output, minimalPdf);
  const operation = createOperationProvenance({
    type: 'test-rewrite',
    inputs: [{ documentId: record.id, sha256: record.sha256, role: 'primary' }],
    parameters: {},
    expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });

  const artifact = await store.promotePdfArtifact(record.id, output, {
    displayName: 'derived.pdf', operation, expectedSha256: minimalPdfDigest,
  });
  assert.equal(artifact.operation.schemaVersion, 1);
  assert.equal(artifact.operation.inputs[0].sha256, record.sha256);
  assert.equal(Object.isFrozen(artifact.operation), true);

  await assert.rejects(
    store.promotePdfArtifact(record.id, output, {
      operation: { type: 'legacy-operation' }, expectedSha256: minimalPdfDigest,
    }),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
});

test('artifact deletion removes one derived artifact without touching its source', async (context) => {
  const root = storeRoot();
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const record = await store.createDocument({ stream: Readable.from([minimalPdf]), displayName: 'source.pdf' });
  const output = join(root, 'derived-for-delete.pdf');
  writeFileSync(output, minimalPdf);
  const operation = createOperationProvenance({
    type: 'test-rewrite',
    inputs: [{ documentId: record.id, sha256: record.sha256, role: 'primary' }],
    parameters: {}, expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });
  const artifact = await store.promotePdfArtifact(record.id, output, {
    displayName: 'derived.pdf', operation, expectedSha256: minimalPdfDigest,
  });
  const retainedPath = store.getArtifact(artifact.id).filePath;

  await store.deleteArtifact(artifact.id);

  assert.equal(existsSync(retainedPath), false);
  assert.throws(() => store.getArtifact(artifact.id), { code: 'ARTIFACT_NOT_FOUND', status: 404 });
  assert.equal(await store.verifySource(record.id), true);
});

test('artifact transfer claim is atomic and cleans its private bytes exactly once', async (context) => {
  const root = storeRoot();
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const record = await store.createDocument({
    stream: Readable.from([minimalPdf]), displayName: 'source.pdf',
  });
  const output = join(root, 'derived-for-transfer.pdf');
  writeFileSync(output, minimalPdf);
  const operation = createOperationProvenance({
    type: 'pdfkit-protection-removal',
    inputs: [{ documentId: record.id, sha256: record.sha256, role: 'source' }],
    parameters: {}, expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });
  const artifact = await store.promotePdfArtifact(record.id, output, {
    displayName: 'cleartext.pdf', operation, expectedSha256: minimalPdfDigest,
  });
  const retainedPath = store.getArtifact(artifact.id).filePath;

  const claim = store.claimArtifactForTransfer(artifact.id);
  assert.equal(claim.artifact.id, artifact.id);
  assert.equal(existsSync(retainedPath), true);
  assert.throws(
    () => store.claimArtifactForTransfer(artifact.id),
    { code: 'ARTIFACT_NOT_FOUND', status: 404 },
  );
  assert.throws(() => store.getArtifact(artifact.id), { code: 'ARTIFACT_NOT_FOUND', status: 404 });

  await Promise.all([claim.cleanup(), claim.cleanup()]);
  assert.equal(existsSync(retainedPath), false);
  assert.equal(await store.verifySource(record.id), true);
});

test('artifact promotion rejects symbolic and multi-link native outputs', async (context) => {
  const root = storeRoot();
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const record = await store.createDocument({ stream: Readable.from([minimalPdf]), displayName: 'source.pdf' });
  const operation = createOperationProvenance({
    type: 'test-rewrite',
    inputs: [{ documentId: record.id, sha256: record.sha256, role: 'primary' }],
    parameters: {}, expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });
  const output = join(root, 'native-output.pdf');
  const symbolic = join(root, 'symbolic-output.pdf');
  const hardLink = join(root, 'hard-link-output.pdf');
  writeFileSync(output, minimalPdf);
  symlinkSync(output, symbolic);
  await assert.rejects(store.promotePdfArtifact(record.id, symbolic, { operation, expectedSha256: minimalPdfDigest }), {
    code: 'INVALID_ENGINE_OUTPUT', status: 502,
  });
  unlinkSync(symbolic);
  linkSync(output, hardLink);
  await assert.rejects(store.promotePdfArtifact(record.id, output, { operation, expectedSha256: minimalPdfDigest }), {
    code: 'INVALID_ENGINE_OUTPUT', status: 502,
  });
  await assert.rejects(store.promotePdfArtifact(record.id, hardLink, { operation, expectedSha256: minimalPdfDigest }), {
    code: 'INVALID_ENGINE_OUTPUT', status: 502,
  });
});

test('artifact promotion binds provenance and copied bytes to validated digests', async (context) => {
  const root = storeRoot();
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const record = await store.createDocument({ stream: Readable.from([minimalPdf]), displayName: 'source.pdf' });
  const output = join(root, 'validated.pdf');
  writeFileSync(output, minimalPdf);
  const operation = createOperationProvenance({
    type: 'test-rewrite',
    inputs: [{ documentId: record.id, sha256: 'f'.repeat(64), role: 'primary' }],
    parameters: {}, expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });

  await assert.rejects(store.promotePdfArtifact(record.id, output, {
    operation, expectedSha256: minimalPdfDigest,
  }), { code: 'INVALID_OPERATION_PROVENANCE', status: 500 });

  const validOperation = createOperationProvenance({
    type: 'test-rewrite',
    inputs: [{ documentId: record.id, sha256: record.sha256, role: 'primary' }],
    parameters: {}, expected: { pageCount: 1 },
    validation: { passed: true, validators: ['fixture-contract'] },
  });
  await assert.rejects(store.promotePdfArtifact(record.id, output, {
    operation: validOperation, expectedSha256: '0'.repeat(64),
  }), { code: 'ARTIFACT_DIGEST_MISMATCH', status: 502 });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.promotePdfArtifact(record.id, output, {
    operation: validOperation, expectedSha256: minimalPdfDigest, signal: controller.signal,
  }), { code: 'JOB_CANCELLED', status: 499 });
});

test('derived documents retain validated input-asset provenance', async (context) => {
  const store = await new DocumentStore({ root: storeRoot() }).initialize();
  context.after(() => store.dispose());
  const assetId = '123e4567-e89b-42d3-a456-426614174000';
  const operation = createOperationProvenance({
    type: 'office-to-pdf',
    inputs: [{ assetId, sha256: 'b'.repeat(64), role: 'source' }],
    parameters: { format: 'docx' },
    expected: { pageCount: 1 },
    validation: { passed: true, validators: ['pdfinfo-page-count'], pageCount: 1 },
  });
  const derived = await store.createDocument({
    stream: Readable.from([minimalPdf]), displayName: 'converted.pdf', operation,
  });
  assert.equal(derived.origin, 'derived');
  assert.equal(derived.operation.type, 'office-to-pdf');
  assert.equal(derived.operation.inputs[0].assetId, assetId);
});
