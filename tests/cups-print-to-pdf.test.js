import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createCupsfilterAdapter } from '../scripts/host/adapters/cupsfilter.mjs';
import {
  CupsPrintToPdfService, MAX_CUPS_TEXT_INPUT_BYTES,
} from '../scripts/host/cups-print-to-pdf-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';

test('CUPS adapter requires Darwin, the fixed executable, and cgtexttopdf plan', async () => {
  const adapter = createCupsfilterAdapter({ platform: 'linux', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => {} });
  await assert.rejects(adapter.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private', signal: undefined }), { code: 'CUPS_FILTER_UNAVAILABLE' });
  const plan = createCupsfilterAdapter({ platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => {}, processRunner: async () => ({ stdout: 'cgtexttopdf\n' }) });
  await assert.doesNotReject(plan.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private', signal: undefined }));
  const forged = createCupsfilterAdapter({ platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => {}, processRunner: async () => ({ stdout: 'not-cgtexttopdf\n' }) });
  await assert.rejects(forged.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private', signal: undefined }), { code: 'CUPS_FILTER_PLAN_INVALID' });
  const expanded = createCupsfilterAdapter({ platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => {}, processRunner: async () => ({ stdout: 'pre-filter\ncgtexttopdf\npost-filter\n' }) });
  await assert.rejects(expanded.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private', signal: undefined }), { code: 'CUPS_FILTER_PLAN_INVALID' });
});

test('CUPS adapter uses only fixed argv and fails closed on engine/output faults', async () => {
  const calls = [];
  const good = createCupsfilterAdapter({
    platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    accessImpl: async () => {}, processRunner: async (request) => {
      calls.push(request);
      return { stdout: request.stdoutEncoding === 'buffer' ? Buffer.from('%PDF-\xff') : 'cgtexttopdf\n' };
    },
  });
  await good.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private/job' });
  await good.convert({ sourcePath: '/private/source.txt', cwd: '/private/job' });
  assert.deepEqual(calls[0].args, ['--list-filters', '-i', 'text/plain', '-m', 'application/pdf', '--', '/private/source.txt']);
  assert.deepEqual(calls[1].args, ['-i', 'text/plain', '-m', 'application/pdf', '--', '/private/source.txt']);
  assert.equal(calls[1].stdoutEncoding, 'buffer');
  for (const lstatImpl of [
    async () => ({ isFile: () => false, isSymbolicLink: () => false }),
    async () => ({ isFile: () => true, isSymbolicLink: () => true }),
  ]) {
    const adapter = createCupsfilterAdapter({ platform: 'darwin', lstatImpl, accessImpl: async () => {} });
    await assert.rejects(adapter.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private' }), { code: 'CUPS_FILTER_UNAVAILABLE' });
  }
  const unavailable = createCupsfilterAdapter({ platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => { throw new Error('denied'); } });
  await assert.rejects(unavailable.verifyPlan({ sourcePath: '/private/source.txt', cwd: '/private' }), { code: 'CUPS_FILTER_UNAVAILABLE' });
  for (const stdout of ['not bytes', Buffer.alloc(64 * 1024 * 1024 + 1)]) {
    const adapter = createCupsfilterAdapter({ platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => {}, processRunner: async () => ({ stdout }) });
    await assert.rejects(adapter.convert({ sourcePath: '/private/source.txt', cwd: '/private' }), { code: 'CUPS_FILTER_OUTPUT_INVALID' });
  }
  const failed = createCupsfilterAdapter({ platform: 'darwin', lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false }), accessImpl: async () => {}, processRunner: async () => { throw new Error('engine failed'); } });
  await assert.rejects(failed.convert({ sourcePath: '/private/source.txt', cwd: '/private' }), { code: 'CUPS_FILTER_FAILED' });
});

test('CUPS service retains and reinspects a bounded strict UTF-8 text PDF', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cups-')); const inputs = await new InputAssetStore({ root }).initialize(); const documents = await new DocumentStore({ root }).initialize(); t.after(async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); });
  const asset = await inputs.createInput({ stream: Readable.from([Buffer.from('x')]), displayName: 'fixture.txt', mediaType: 'text/plain' }); const pdf = createTextPdf({ text: 'CUPS fixture' });
  const service = new CupsPrintToPdfService({ inputs, documents, cupsfilter: { verifyPlan: async () => ['cgtexttopdf'], convert: async () => pdf }, poppler: { execute: async (name, args) => ({ stdout: name === 'inspectStdin' ? 'Pages: 1\nEncrypted: no\nJavaScript: no\nForm: none\n' : name === 'inspectPageStdin' ? 'Page size: 612 x 792 pts\n' : 'CUPS fixture\n' }) } });
  const document = await service.convertInput(asset.id); const evidence = await service.prepareRetainedArtifactExport(document.id); assert.equal(document.operation.type, 'cups-text-to-pdf'); assert.equal(evidence.bytes.equals(pdf), true); assert.equal(evidence.pages[0].widthPoints, 612);
});

test('CUPS service rejects NUL, non-UTF8, and oversized text before filtering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cups-invalid-'));
  const inputs = await new InputAssetStore({ root }).initialize();
  const documents = await new DocumentStore({ root }).initialize();
  t.after(async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); });
  const service = new CupsPrintToPdfService({
    inputs, documents, poppler: { execute: async () => ({ stdout: '' }) },
    cupsfilter: { verifyPlan: async () => { throw new Error('must not run'); }, convert: async () => Buffer.alloc(5) },
  });
  await assert.rejects(inputs.createInput({
    stream: Readable.from([Buffer.from('x\0')]), displayName: 'nul.txt', mediaType: 'text/plain',
  }), { code: 'INVALID_INPUT_SIGNATURE' });
  for (const [name, bytes, code] of [
    ['encoding.txt', Buffer.from([0xc3]), 'INVALID_CUPS_TEXT_INPUT'],
    ['large.txt', Buffer.alloc(MAX_CUPS_TEXT_INPUT_BYTES + 1, 0x78), 'UNSUPPORTED_CUPS_TEXT_INPUT'],
  ]) {
    const asset = await inputs.createInput({ stream: Readable.from([bytes]), displayName: name, mediaType: 'text/plain' });
    await assert.rejects(service.convertInput(asset.id), { code });
  }
});

test('CUPS service rejects hostile Poppler evidence and source/artifact drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cups-hostile-'));
  const inputs = await new InputAssetStore({ root }).initialize();
  const documents = await new DocumentStore({ root }).initialize();
  t.after(async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); });
  const asset = await inputs.createInput({ stream: Readable.from([Buffer.from('fixture')]), displayName: 'fixture.txt', mediaType: 'text/plain' });
  const pdf = createTextPdf({ text: 'fixture' });
  const output = (inspection, page = 'Page size: 612 x 792 pts\n', extracted = 'fixture\n') => ({
    execute: async (name) => ({ stdout: name === 'inspectStdin' ? inspection : name === 'inspectPageStdin' ? page : extracted }),
  });
  for (const poppler of [
    output('Pages: 1\nEncrypted: yes\nJavaScript: no\nForm: none\n'),
    output('Pages: 1\nEncrypted: no\nJavaScript: no\nForm: none\n', 'Page size: 15000 x 792 pts\n'),
    output('Pages: 65\nEncrypted: no\nJavaScript: no\nForm: none\n'),
  ]) {
    const service = new CupsPrintToPdfService({ inputs, documents, poppler, cupsfilter: { verifyPlan: async () => ['cgtexttopdf'], convert: async () => pdf } });
    await assert.rejects(service.convertInput(asset.id), (error) => [
      'INVALID_CUPS_PDF_DOCUMENT', 'PAGE_GEOMETRY_LIMIT',
    ].includes(error.code));
  }
  const service = new CupsPrintToPdfService({ inputs, documents, poppler: output('Pages: 1\nEncrypted: no\nJavaScript: no\nForm: none\n'), cupsfilter: { verifyPlan: async () => ['cgtexttopdf'], convert: async () => pdf } });
  let pageLimitCalls = 0;
  const excessivePages = new CupsPrintToPdfService({
    inputs, documents,
    poppler: { execute: async () => { pageLimitCalls += 1; return { stdout: 'Pages: 65\nEncrypted: no\nJavaScript: no\nForm: none\n' }; } },
    cupsfilter: { verifyPlan: async () => ['cgtexttopdf'], convert: async () => pdf },
  });
  await assert.rejects(excessivePages.convertInput(asset.id), { code: 'INVALID_CUPS_PDF_DOCUMENT' });
  assert.equal(pageLimitCalls, 1);
  const document = await service.convertInput(asset.id);
  const forged = new CupsPrintToPdfService({
    inputs, poppler: output('Pages: 1\nEncrypted: no\nJavaScript: no\nForm: none\n'),
    documents: { createDocument() {}, getDocument: () => ({ ...document, operation: {} }) },
    cupsfilter: { verifyPlan: async () => ['cgtexttopdf'], convert: async () => pdf },
  });
  await assert.rejects(forged.prepareRetainedArtifactExport(document.id), { code: 'INVALID_CUPS_PDF_DOCUMENT' });
  await writeFile(documents.getSourcePath(document.id), Buffer.from('%PDF-1.7\ndrift'));
  await assert.rejects(service.prepareRetainedArtifactExport(document.id), { code: 'SOURCE_INTEGRITY_FAILED' });
});

test('CUPS service revokes a promoted document when cancellation arrives after promotion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cups-cancel-'));
  const inputs = await new InputAssetStore({ root }).initialize();
  const documents = await new DocumentStore({ root }).initialize();
  t.after(async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); });
  const asset = await inputs.createInput({ stream: Readable.from([Buffer.from('fixture')]), displayName: 'fixture.txt', mediaType: 'text/plain' });
  const controller = new AbortController();
  const create = documents.createDocument.bind(documents);
  let promoted;
  documents.createDocument = async (...args) => { promoted = await create(...args); controller.abort(); return promoted; };
  const poppler = { execute: async (name) => ({ stdout: name === 'inspectStdin' ? 'Pages: 1\nEncrypted: no\nJavaScript: no\nForm: none\n' : name === 'inspectPageStdin' ? 'Page size: 612 x 792 pts\n' : 'fixture\n' }) };
  const service = new CupsPrintToPdfService({ inputs, documents, poppler, cupsfilter: { verifyPlan: async () => ['cgtexttopdf'], convert: async () => createTextPdf({ text: 'fixture' }) } });
  await assert.rejects(service.convertInput(asset.id, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.throws(() => documents.getDocument(promoted.id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('installed macOS CUPS and Poppler path produces a passive letter PDF', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  await access('/usr/sbin/cupsfilter');
  const root = await mkdtemp(join(tmpdir(), 'platen-cups-installed-'));
  const inputs = await new InputAssetStore({ root }).initialize();
  const documents = await new DocumentStore({ root }).initialize();
  t.after(async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); });
  const asset = await inputs.createInput({
    stream: Readable.from([Buffer.from('CUPS installed fixture\n')]),
    displayName: 'installed.txt', mediaType: 'text/plain',
  });
  const service = new CupsPrintToPdfService({
    inputs, documents, poppler: new PopplerAdapter({ registry: new EngineRegistry() }),
  });
  const document = await service.convertInput(asset.id);
  const evidence = await service.prepareRetainedArtifactExport(document.id);
  assert.equal(evidence.inspection.pageCount, 1);
  assert.deepEqual(evidence.pages, [{ page: 1, widthPoints: 612, heightPoints: 792 }]);
  assert.match(evidence.textPages[0].text, /CUPS installed fixture/u);
  assert.deepEqual(
    { encrypted: evidence.inspection.encrypted, javascript: evidence.inspection.javascript, form: evidence.inspection.form },
    { encrypted: 'no', javascript: 'no', form: 'none' },
  );
});
