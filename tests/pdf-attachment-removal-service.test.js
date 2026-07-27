import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod, link, mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import {
  PdfAttachmentRemovalService,
} from '../scripts/host/pdf-attachment-removal-service.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const request = Object.freeze({ profile: 'local-document-attachment-removal-v1' });
const attachmentName = 'note.txt';
const attachmentBytes = Buffer.from('private attachment');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function proof(source, output) {
  return Object.freeze({
    profile: request.profile, sourceBytes: source.length, outputBytes: output.length,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    outputSha256: createHash('sha256').update(output).digest('hex'),
    nameSha256: createHash('sha256').update(attachmentName).digest('hex'),
    contentSha256: createHash('sha256').update(attachmentBytes).digest('hex'),
    contentBytes: attachmentBytes.length, removedObjectCount: 3,
    closedClassicRevision: true, priorRevisionsAbsent: true,
    attachmentSurfacesAbsent: true, removedReferencesUnresolvable: true,
    rootPreserved: true, infoPreserved: true, idPolicy: 'absent',
  });
}

function attachmentPdfWithAnnotation(subtype) {
  const content = attachmentBytes.toString('latin1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 5 0 R >> /PageMode /UseAttachments >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources <<>> /Contents 4 0 R /Annots [<< /Type /Annot /Subtype /${subtype} /Rect [0 0 10 10] /FS 8 0 R >>] >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Names [(${attachmentName}) 6 0 R] >>`,
    `<< /Type /Filespec /F (${attachmentName}) /UF (${attachmentName}) /EF << /F 7 0 R >> >>`,
    `<< /Type /EmbeddedFile /Length ${attachmentBytes.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Filespec /F (alternate.bin) /UF (alternate.bin) /EF << /F 9 0 R >> >>',
    '<< /Type /EmbeddedFile /Length 3 >>\nstream\nxyz\nendstream',
  ];
  const chunks = ['%PDF-1.7\n'];
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function popplerFixture(options, output, observed) {
  return { execute: async (operation, parameters) => {
    const isOutput = String(parameters.input ?? '').endsWith('output.pdf');
    if (operation === 'inspect') {
      return {
        stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\n',
        stderr: '',
      };
    }
    if (['inspectMetadata', 'inspectCustomMetadata'].includes(operation)) {
      return { stdout: '', stderr: '' };
    }
    if (operation === 'listAttachments') {
      return {
        stdout: isOutput
          ? '0 embedded files\n'
          : `1 embedded files\n1: ${attachmentName}\n`,
        stderr: '',
      };
    }
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'verifySignatures') {
      return {
        stdout: `File '${parameters.input}' does not contain any signatures\n`,
        stderr: '', exitCode: 0,
      };
    }
    if (operation === 'inspectPageBoxes') {
      return {
        stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n',
        stderr: '',
      };
    }
    if (operation === 'extractText') {
      return { stdout: options.contentMismatch && isOutput ? 'changed\f' : 'fixture\f', stderr: '' };
    }
    if (operation === 'extractAttachment') {
      if (options.extractSymlink) {
        await symlink(parameters.input, parameters.output);
        return { stdout: '', stderr: '' };
      }
      if (options.extractHardlink) {
        await link(parameters.input, parameters.output);
        return { stdout: '', stderr: '' };
      }
      await writeFile(parameters.output, attachmentBytes, { mode: 0o600 });
      if (options.extractOversized) {
        await truncate(parameters.output, (8 * 1024 * 1024) + 1);
      }
      return { stdout: '', stderr: options.extractWarning ? 'warning' : '' };
    }
    if (operation === 'renderPagePng') {
      if (options.swapOutput && isOutput && !observed.outputSwapped) {
        await unlink(parameters.input);
        await writeFile(parameters.input, output, { mode: 0o400 });
        observed.outputSwapped = true;
      }
      const rendered = options.renderMismatch && isOutput
        ? Buffer.concat([png, Buffer.from('x')]) : png;
      await writeFile(`${parameters.outputPrefix}.png`, rendered);
      return { stdout: '', stderr: '' };
    }
    assert.fail(operation);
  } };
}

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'attachment-removal-service-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from(`%PDF-1.4\n${'source '.repeat(20)}\nstartxref\n10\n%%EOF\n`);
  const output = Buffer.from(`%PDF-1.4\n${'output '.repeat(20)}\nstartxref\n10\n%%EOF\n`);
  const digest = createHash('sha256').update(source).digest('hex');
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const expectedProof = proof(source, output);
  const controller = options.controller ?? new AbortController();
  const observed = {
    deleted: [], promoted: 0, sourceChecks: 0, outputSwapped: false,
  };
  const store = {
    getDocument: () => ({
      id: documentId, sha256: digest, size: source.length, displayName: 'source.pdf',
    }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      observed.sourceChecks += 1;
      if (options.swapSourceOnRecheck && observed.sourceChecks === 2) {
        await writeFile(sourcePath, Buffer.concat([source, Buffer.from('swapped')]), {
          mode: 0o600,
        });
      }
      assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), digest);
    },
    createJobWorkspace: async () => {
      const path = await mkdtemp(join(root, 'job-'));
      await chmod(path, 0o700);
      return path;
    },
    cleanupJob: async (path) => {
      await rm(path, { recursive: true, force: true });
      if (options.cleanupFailure) throw new Error('cleanup failure');
    },
    promotePdfArtifact: async (_id, _path, promotion) => {
      observed.promoted += 1;
      if (options.abortAfterPromotion) {
        controller.abort(new Error('cancelled after promotion'));
      }
      return {
        id: artifactId, sha256: promotion.expectedSha256,
        displayName: 'attachment-removed.pdf', operation: promotion.operation,
      };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const core = {
    normalizePdfAttachmentRemoval: (value) => value,
    writePdfAttachmentRemoval: (input) => options.overlap
      ? { bytes: input, proof: expectedProof }
      : { bytes: Buffer.from(output), proof: expectedProof },
    inspectPdfAttachmentRemoval: () => options.proofMismatch
      ? { ...expectedProof, removedObjectCount: 4 } : expectedProof,
  };
  return {
    service: new PdfAttachmentRemovalService({
      store, poppler: popplerFixture(options, output, observed), core,
    }),
    digest, controller, observed,
  };
}

test('attachment-removal service rejects overlap and proof disagreement', async (context) => {
  for (const options of [{ overlap: true }, { proofMismatch: true }]) {
    const setup = await fixture(context, options);
    await assert.rejects(
      setup.service.remove(documentId, request, { sourceSha256: setup.digest }),
      { code: 'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID' },
    );
    assert.equal(setup.observed.promoted, 0);
  }
});

test('attachment-removal service rejects Poppler and identity mismatches', async (context) => {
  for (const [options, code] of [
    [{ contentMismatch: true }, 'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID'],
    [{ renderMismatch: true }, 'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID'],
    [{ swapOutput: true }, 'PDF_ATTACHMENT_REMOVAL_WORKSPACE_INVALID'],
  ]) {
    const setup = await fixture(context, options);
    await assert.rejects(
      setup.service.remove(documentId, request, { sourceSha256: setup.digest }),
      { code },
    );
    assert.equal(setup.observed.promoted, 0);
  }
});

test('attachment-removal service rejects hostile extracted attachment files', async (context) => {
  for (const [options, code] of [
    [{ extractSymlink: true }, 'PDF_ATTACHMENT_REMOVAL_ATTACHMENT_INVALID'],
    [{ extractHardlink: true }, 'PDF_ATTACHMENT_REMOVAL_ATTACHMENT_INVALID'],
    [{ extractOversized: true }, 'PDF_ATTACHMENT_REMOVAL_ATTACHMENT_INVALID'],
    [{ extractWarning: true }, 'PDF_ATTACHMENT_REMOVAL_POPPLER_WARNING'],
  ]) {
    const setup = await fixture(context, options);
    await assert.rejects(
      setup.service.remove(documentId, request, { sourceSha256: setup.digest }),
      { code },
    );
    assert.equal(setup.observed.promoted, 0);
  }
});

test('attachment-removal service rechecks the immutable source', async (context) => {
  const setup = await fixture(context, { swapSourceOnRecheck: true });
  await assert.rejects(
    setup.service.remove(documentId, request, { sourceSha256: setup.digest }),
    { code: 'PDF_ATTACHMENT_REMOVAL_FAILED' },
  );
  assert.equal(setup.observed.sourceChecks, 2);
  assert.equal(setup.observed.promoted, 0);
});

test('attachment-removal service revokes cancelled or cleanup-failed promotion', async (context) => {
  const cancelled = await fixture(context, { abortAfterPromotion: true });
  await assert.rejects(cancelled.service.remove(documentId, request, {
    sourceSha256: cancelled.digest, signal: cancelled.controller.signal,
  }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.observed.deleted, [artifactId]);
  const cleanup = await fixture(context, { cleanupFailure: true });
  await assert.rejects(
    cleanup.service.remove(documentId, request, { sourceSha256: cleanup.digest }),
    { code: 'PDF_ATTACHMENT_REMOVAL_CLEANUP_FAILED' },
  );
  assert.deepEqual(cleanup.observed.deleted, [artifactId]);
});

test('installed Poppler service publishes a verified attachment-free artifact', {
  timeout: 30_000,
}, async (context) => {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const required = ['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfdetach', 'pdfsig'];
  if ((await Promise.allSettled(required.map((name) => registry.probe(name))))
    .some(({ status }) => status === 'rejected')) {
    context.skip('Required Poppler tools are unavailable.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'attachment-removal-service-poppler-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const source = makeMultiPagePdf(['attachment removal fixture'], {
    attachment: { name: attachmentName, content: attachmentBytes.toString('utf8') },
  });
  const document = await store.createDocument({
    stream: Readable.from([source]), displayName: 'attachment.pdf',
    mediaType: 'application/pdf',
  });
  const poppler = new PopplerAdapter({ registry, runner });
  const service = new PdfAttachmentRemovalService({ store, poppler });
  const result = await service.remove(document.id, request, {
    sourceSha256: document.sha256,
  });
  const retained = store.getArtifact(result.artifact.id);
  const attachments = await poppler.execute('listAttachments', {
    input: retained.filePath,
  }, { cwd: root, timeoutMs: 30_000 });
  assert.match(attachments.stdout, /0 embedded files/u);
  assert.equal(result.removal.contentSha256, createHash('sha256')
    .update(attachmentBytes).digest('hex'));
  assert.notEqual(result.artifact.sha256, document.sha256);
  assert.equal(await store.verifySource(document.id), true);
  for (const bytes of [
    makeMultiPagePdf(['unicode attachment'], {
      attachment: { name: 'é.txt', content: attachmentBytes.toString('utf8') },
    }),
    attachmentPdfWithAnnotation('FileAttachment'),
  ]) {
    const hostile = await store.createDocument({
      stream: Readable.from([bytes]), displayName: 'unsupported-attachment.pdf',
      mediaType: 'application/pdf',
    });
    await assert.rejects(
      service.remove(hostile.id, request, { sourceSha256: hostile.sha256 }),
      { code: 'PDF_ATTACHMENT_REMOVAL_SOURCE_UNSUPPORTED' },
    );
    assert.equal(await store.verifySource(hostile.id), true);
  }
});
