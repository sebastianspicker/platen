import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { runOoxmlExportCommand } from '../scripts/cli/commands/ooxml-export.mjs';
import { buildOoxml, OOXML_EXPORT_LIMITS, PdfOoxmlExportService } from '../scripts/host/pdf-ooxml-export.mjs';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';

const pages = Object.freeze([{ page: 1, text: 'Alpha\nBeta & <gamma>' }, { page: 2, text: 'Résumé 😀' }]);

test('OOXML builders are deterministic, stored ZIPs, and preserve bounded page text', () => {
  for (const format of ['word', 'excel', 'powerpoint']) {
    const first = buildOoxml(format, pages);
    const second = buildOoxml(format, pages);
    assert.deepEqual(first.bytes, second.bytes);
    const entries = readZipEntries(first.bytes);
    assert.equal(entries.get('[Content_Types].xml')?.length > 0, true);
    const text = [...entries.values()].map((value) => value.toString('utf8')).join('\n');
    assert.match(text, /Alpha/);
    assert.match(text, /Beta &amp; &lt;gamma&gt;/);
  }
  const docx = readZipEntries(buildOoxml('word', pages).bytes).get('word/document.xml').toString('utf8');
  assert.equal((docx.match(/w:type="page"/g) ?? []).length, 1);
  const xlsx = readZipEntries(buildOoxml('excel', pages).bytes).get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.equal((xlsx.match(/<row\b/g) ?? []).length, 4); // header + three source lines
  const pptEntries = readZipEntries(buildOoxml('powerpoint', pages).bytes);
  assert.equal([...pptEntries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length, 2);
});

test('OOXML builders reject XML-hostile controls and oversized page arrays', () => {
  assert.throws(() => buildOoxml('word', [{ page: 1, text: 'bad\u0001' }]), { code: 'INVALID_OOXML_TEXT' });
  assert.throws(() => buildOoxml('excel', Array.from({ length: 201 }, (_, index) => ({ page: index + 1, text: 'x' }))), { code: 'INVALID_OOXML_TEXT_PAGES' });
  assert.throws(() => buildOoxml('powerpoint', [{ page: 2, text: 'x' }]), { code: 'INVALID_OOXML_TEXT_PAGES' });
});

test('OOXML service rejects caller-controlled or source-mismatched extracted text envelopes', async () => {
  const sourceSha256 = '1'.repeat(64);
  const store = { getDocument: () => ({ id: '12121212-1212-4121-8121-121212121212', sha256: sourceSha256 }), verifySource: async () => {} };
  const base = { inspect: async () => ({ pageCount: 1 }) };
  for (const envelope of [
    { sourceDigest: '2'.repeat(64), pageCount: 1, pages: [{ page: 1, text: 'forged' }] },
    { sourceDigest: sourceSha256, pageCount: 1, pages: [{ page: 1, text: 'forged' }], extra: true },
  ]) {
    const extractor = { ...base, extractText: async () => envelope };
    await assert.rejects(new PdfOoxmlExportService({ store: { ...store, promoteOoxmlArtifact: async () => {} }, extractor }).export(store.getDocument().id, 'word', { sourceSha256 }), { code: 'OOXML_TEXT_UNBOUND' });
  }
});

test('OOXML service rejects accessor or symbol options/envelopes and bounds inspected page count before extraction', async () => {
  const sourceSha256 = '3'.repeat(64);
  const document = { id: '13131313-1313-4131-8131-131313131313', sha256: sourceSha256 };
  const store = { getDocument: () => document, verifySource: async () => {}, promoteOoxmlArtifact: async () => {} };
  const accessorOptions = { sourceSha256 };
  Object.defineProperty(accessorOptions, 'signal', { get: () => undefined, enumerable: true });
  await assert.rejects(new PdfOoxmlExportService({ store, extractor: { extractText: async () => ({}) } }).export(document.id, 'word', accessorOptions), { name: 'TypeError' });
  const symbolOptions = { sourceSha256, [Symbol('unexpected')]: true };
  await assert.rejects(new PdfOoxmlExportService({ store, extractor: { extractText: async () => ({}) } }).export(document.id, 'word', symbolOptions), { name: 'TypeError' });
  let extracted = false;
  await assert.rejects(new PdfOoxmlExportService({ store, extractor: {
    inspect: async () => ({ pageCount: OOXML_EXPORT_LIMITS.maximumPages + 1 }),
    extractText: async () => { extracted = true; return {}; },
  } }).export(document.id, 'word', { sourceSha256 }), { code: 'OOXML_EXPORT_LIMIT_EXCEEDED' });
  assert.equal(extracted, false);
  const envelope = { sourceDigest: sourceSha256, pageCount: 1, pages: [{ page: 1, text: 'safe' }] };
  Object.defineProperty(envelope, 'sourceDigest', { get: () => sourceSha256, enumerable: true });
  await assert.rejects(new PdfOoxmlExportService({ store, extractor: { inspect: async () => ({ pageCount: 1 }), extractText: async () => envelope } }).export(document.id, 'word', { sourceSha256 }), { code: 'OOXML_TEXT_UNBOUND' });
  const page = { page: 1, text: 'safe' };
  Object.defineProperty(page, 'text', { get: () => 'safe', enumerable: true });
  await assert.rejects(new PdfOoxmlExportService({ store, extractor: { inspect: async () => ({ pageCount: 1 }), extractText: async () => ({ sourceDigest: sourceSha256, pageCount: 1, pages: [page] }) } }).export(document.id, 'word', { sourceSha256 }), { code: 'OOXML_TEXT_UNBOUND' });
});

test('OOXML service re-verifies the source, binds the digest, promotes, and cleans its workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-export-test-'));
  const sourceBytes = Buffer.from('%PDF-1.7\nfixture');
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const calls = [];
  const store = {
    getDocument: () => ({ id: '11111111-1111-4111-8111-111111111111', displayName: 'source.pdf', sha256: sourceSha256 }),
    verifySource: async () => { calls.push('verify'); },
    createJobWorkspace: async () => root,
    cleanupJob: async () => { calls.push('cleanup'); },
    promoteOoxmlArtifact: async (_id, outputPath, options) => {
      calls.push('promote');
      const bytes = readFileSync(outputPath);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256);
      assert.equal(options.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      return { id: '22222222-2222-4222-8222-222222222222', documentId: _id, sha256: options.expectedSha256, mediaType: options.mediaType, size: bytes.length, displayName: 'source.docx' };
    },
  };
  const extractor = { inspect: async () => ({ pageCount: 2 }), extractText: async () => ({ sourceDigest: sourceSha256, pageCount: 2, pages }) };
  const result = await new PdfOoxmlExportService({ store, extractor }).export(
    store.getDocument().id, 'word', { sourceSha256 },
  );
  assert.equal(result.kind, 'pdf-ooxml-export');
  assert.equal(result.pageCount, 2);
  assert.deepEqual(calls, ['verify', 'verify', 'promote', 'verify', 'cleanup']);
});

test('document store OOXML promotion enforces exact media type and safely retains output', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-store-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const source = await store.createDocument({ stream: Readable.from([Buffer.from('%PDF-1.7\nfixture')]), displayName: 'source.pdf' });
  const output = join(root, 'out.docx');
  const bytes = buildOoxml('word', pages).bytes;
  writeFileSync(output, bytes, { mode: 0o600 });
  const operation = {
    schemaVersion: 1,
    id: '33333333-3333-4333-8333-333333333333',
    type: 'export-word',
    inputs: [{ documentId: source.id, sha256: source.sha256, role: 'source' }],
    parameters: {}, expected: {},
    validation: { passed: true, validators: ['fixture'] },
    completedAt: '2026-01-01T00:00:00.000Z',
  };
  const artifact = await store.promoteOoxmlArtifact(source.id, output, {
    displayName: 'export.docx', extension: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', operation,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.equal(artifact.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(readFileSync(store.getArtifact(artifact.id).filePath).equals(bytes), true);
  await assert.rejects(store.promoteOoxmlArtifact(source.id, output, { displayName: 'bad.docx', extension: 'docx', mediaType: 'application/pdf', operation, expectedSha256: artifact.sha256 }), { code: 'INVALID_OOXML_ARTIFACT' });
  await store.deleteArtifact(artifact.id);
});

test('OOXML service revokes a promoted artifact when workspace cleanup fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-cleanup-test-'));
  const sourceSha256 = 'b'.repeat(64);
  const deleted = [];
  const store = {
    getDocument: () => ({ id: '44444444-4444-4444-8444-444444444444', displayName: 'source.pdf', sha256: sourceSha256 }),
    verifySource: async () => {}, createJobWorkspace: async () => root,
    cleanupJob: async () => { throw Object.assign(new Error('cleanup failed'), { code: 'CLEANUP_FAILED' }); },
    deleteArtifact: async (id) => deleted.push(id),
    promoteOoxmlArtifact: async (_id, outputPath, options) => ({ id: '55555555-5555-4555-8555-555555555555', documentId: _id, sha256: options.expectedSha256, mediaType: options.mediaType, size: readFileSync(outputPath).length, displayName: 'source.xlsx' }),
  };
  const extractor = { inspect: async () => ({ pageCount: 2 }), extractText: async () => ({ sourceDigest: sourceSha256, pageCount: 2, pages }) };
  await assert.rejects(new PdfOoxmlExportService({ store, extractor }).export(store.getDocument().id, 'excel', { sourceSha256 }), { code: 'OOXML_CLEANUP_FAILED' });
  assert.deepEqual(deleted, ['55555555-5555-4555-8555-555555555555']);
});

test('OOXML service reports both workspace cleanup and artifact revocation failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-cleanup-aggregate-test-'));
  const sourceSha256 = 'c'.repeat(64);
  const store = {
    getDocument: () => ({ id: '66666666-6666-4666-8666-666666666666', displayName: 'source.pdf', sha256: sourceSha256 }),
    verifySource: async () => {}, createJobWorkspace: async () => root,
    cleanupJob: async () => { throw Object.assign(new Error('cleanup failed'), { code: 'CLEANUP_FAILED' }); },
    deleteArtifact: async () => { throw Object.assign(new Error('revoke failed'), { code: 'REVOKE_FAILED' }); },
    promoteOoxmlArtifact: async (_id, outputPath, options) => ({ id: '77777777-7777-4777-8777-777777777777', documentId: _id, sha256: options.expectedSha256, mediaType: options.mediaType, size: readFileSync(outputPath).length, displayName: 'source.xlsx' }),
  };
  const extractor = { inspect: async () => ({ pageCount: 2 }), extractText: async () => ({ sourceDigest: sourceSha256, pageCount: 2, pages }) };
  await assert.rejects(new PdfOoxmlExportService({ store, extractor }).export(store.getDocument().id, 'excel', { sourceSha256 }), (error) => error.code === 'OOXML_CLEANUP_FAILED' && error instanceof AggregateError && error.cause instanceof AggregateError && error.errors.map((item) => item.code).sort().join(',') === 'CLEANUP_FAILED,REVOKE_FAILED');
});

test('OOXML CLI transfers only an exact stored artifact and deletes it after commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-cli-test-'));
  const bytes = buildOoxml('word', pages).bytes;
  const filePath = join(root, 'artifact.docx'); writeFileSync(filePath, bytes);
  const document = { id: '88888888-8888-4888-8888-888888888888', sha256: 'd'.repeat(64) };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const artifact = { id: '99999999-9999-4999-8999-999999999999', documentId: document.id, displayName: 'export.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: bytes.length, sha256: digest, filePath };
  const calls = [];
  const application = { ooxmlExport: { export: async () => ({ kind: 'pdf-ooxml-export', format: 'word', extension: 'docx', pageCount: 2, sourceDigest: document.sha256, artifact, limitations: [] }) }, store: { getArtifact: () => artifact, deleteArtifact: async (id) => calls.push(['delete', id]) } };
  const runtime = { cancelled() {}, canonicalOutputTarget: async () => {}, copyExclusive: async (source, target) => { calls.push(['copy', source, target]); }, emit: async (_stdout, value) => calls.push(['emit', value]) };
  await runOoxmlExportCommand(application, { format: 'word', output: join(root, 'out.docx') }, document, null, undefined, runtime);
  assert.equal(calls[0][0], 'copy'); assert.deepEqual(calls[1], ['delete', artifact.id]); assert.equal(calls[2][0], 'emit');
});

test('OOXML CLI rejects forged artifacts and cleans trusted IDs on copy failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-cli-failure-test-')); const bytes = buildOoxml('excel', pages).bytes; const filePath = join(root, 'artifact.xlsx'); writeFileSync(filePath, bytes);
  const document = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sha256: 'e'.repeat(64) }; const artifact = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', documentId: document.id, displayName: 'export.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), filePath };
  const deleted = []; const application = { ooxmlExport: { export: async () => ({ format: 'excel', extension: 'xlsx', sourceDigest: document.sha256, artifact, limitations: [] }) }, store: { getArtifact: () => artifact, deleteArtifact: async (id) => deleted.push(id) } };
  const runtime = { cancelled() {}, canonicalOutputTarget: async () => {}, copyExclusive: async () => { throw Object.assign(new Error('copy failed'), { code: 'COPY_FAILED' }); }, emit: async () => {} };
  await assert.rejects(runOoxmlExportCommand(application, { format: 'excel', output: join(root, 'out.xlsx') }, document, null, undefined, runtime), { code: 'COPY_FAILED' });
  assert.deepEqual(deleted, [artifact.id]);
});

test('OOXML CLI never deletes an unrelated artifact named by a forged result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ooxml-cli-forged-id-test-'));
  const bytes = buildOoxml('word', pages).bytes;
  const unrelatedPath = join(root, 'unrelated.docx'); writeFileSync(unrelatedPath, bytes);
  const document = { id: 'abababab-abab-4aba-8aba-abababababab', sha256: 'f'.repeat(64) };
  const unrelated = { id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd', documentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', displayName: 'unrelated.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), filePath: unrelatedPath };
  const deleted = [];
  const application = { ooxmlExport: { export: async () => ({ format: 'word', extension: 'docx', sourceDigest: document.sha256, artifact: { id: unrelated.id, documentId: document.id, mediaType: unrelated.mediaType, size: bytes.length, sha256: unrelated.sha256, displayName: unrelated.displayName }, limitations: [] }) }, store: { getArtifact: () => unrelated, deleteArtifact: async (id) => deleted.push(id) } };
  const runtime = { cancelled() {}, canonicalOutputTarget: async () => {}, copyExclusive: async () => {}, emit: async () => {} };
  await assert.rejects(runOoxmlExportCommand(application, { format: 'word', output: join(root, 'out.docx') }, document, null, undefined, runtime), { code: 'CLI_OOXML_ARTIFACT_INVALID' });
  assert.deepEqual(deleted, []);
});
