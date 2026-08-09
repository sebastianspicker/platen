import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { handlers } from '../scripts/host/professional-capability/page-organization.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';

async function fixture(t) {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite']
      .map((path) => access(path)));
  } catch {
    t.skip('Poppler page composition tools are not installed in the fixed engine search path.');
    return null;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-split-rule-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const registry = new EngineRegistry();
  const service = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const primary = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['First', 'Second', 'Third'], {
      cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]],
    })]), displayName: 'primary.pdf',
  });
  const primaryContext = { store, service, documentId: primary.id, sourceSha256: primary.sha256 };
  return { store, service, primary, primaryContext };
}

async function textPages(store, service, bytes, displayName = 'split.pdf') {
  const document = await store.createDocument({ stream: Readable.from([bytes]), displayName });
  const inspection = await service.inspect(document.id);
  return (await service.extractText(document.id, inspection.pageCount))
    .map(({ text }) => text.trim());
}

function requireFailure(error) {
  return error.code === 'PAGES_OUTPUT_INVALID' && error.status === 502;
}

test('pages.split-by-rule validates strict source-bound output count, order, and provenance', async (t) => {
  const context = await fixture(t);
  if (!context) return;
  const { store, service, primaryContext } = context;
  const result = await handlers['pages.split-by-rule']({ ...primaryContext, everyN: 2 });
  assert.equal(result.method, 'source-bound-poppler-page-count-split');
  assert.equal(result.parts, 2);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.everyN, 2);
  assert.equal(await store.verifySource(context.primary.id), true);
  const pages = await Promise.all(result.pdfArtifacts.map((bytes, index) => textPages(store, service, bytes, `rule-${index}.pdf`)));
  assert.deepEqual(pages, [['First', 'Second'], ['Third']]);
  assert.deepEqual(result.artifacts.map((artifact) => ({ ...artifact.operation?.parameters?.splitRule })), [
    { kind: 'every-pages', pagesPerOutput: 2, outputIndex: 1, outputCount: 2 },
    { kind: 'every-pages', pagesPerOutput: 2, outputIndex: 2, outputCount: 2 },
  ]);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.operation?.parameters?.selections.map((selection) => ({ ...selection }))), [
    [{ input: 0, page: 1 }, { input: 0, page: 2 }],
    [{ input: 0, page: 3 }],
  ]);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.operation.validation.pageCount), [2, 1]);
  assert.deepEqual(result.artifacts.map((artifact, index) => createHash('sha256').update(result.pdfArtifacts[index]).digest('hex')), [
    result.artifacts[0].sha256,
    result.artifacts[1].sha256,
  ]);
});

test('split-by-rule fails closed when output bytes are tampered after split', async (t) => {
  const context = await fixture(t);
  if (!context) return;
  const { store, service, primaryContext } = context;
  const tamperedService = {
    inspect: service.inspect.bind(service),
    async splitByPageCount(documentId, everyN, options) {
      const artifacts = await service.splitByPageCount(documentId, everyN, options);
      const artifact = artifacts[0];
      const artifactPath = store.getArtifact(artifact.id).filePath;
      await writeFile(artifactPath, Buffer.concat([await readFile(artifactPath), Buffer.from('%tampered%', 'utf8')]));
      return artifacts;
    },
  };
  await assert.rejects(
    handlers['pages.split-by-rule']({ ...primaryContext, everyN: 2, service: tamperedService }),
    requireFailure,
  );
});

test('split-by-rule fails closed when split-rule provenance is forged', async (t) => {
  const context = await fixture(t);
  if (!context) return;
  const { store, primaryContext } = context;
  const tamperedStore = Object.create(store);
  tamperedStore.getArtifact = function getArtifact(artifactId) {
      const artifact = store.getArtifact(artifactId);
      return {
        ...artifact,
        operation: artifact.operation && {
          ...artifact.operation,
          parameters: {
            ...artifact.operation.parameters,
            splitRule: {
              ...artifact.operation.parameters.splitRule,
              outputCount: artifact.operation.parameters.splitRule.outputCount + 1,
            },
          },
        },
      };
  };
  await assert.rejects(
    handlers['pages.split-by-rule']({ ...primaryContext, everyN: 2, store: tamperedStore }),
    requireFailure,
  );
});

test('split-by-rule propagates cancellation before publication', async (t) => {
  const context = await fixture(t);
  if (!context) return;
  const { service, primaryContext } = context;
  const controller = new AbortController();
  const cancelledService = {
    inspect: service.inspect.bind(service),
    async splitByPageCount(documentId, everyN, options) {
      const artifacts = await service.splitByPageCount(documentId, everyN, options);
      controller.abort();
      return artifacts;
    },
  };
  await assert.rejects(
    handlers['pages.split-by-rule']({ ...primaryContext, everyN: 2, signal: controller.signal, service: cancelledService }),
    (error) => error.code === 'JOB_CANCELLED' && error.status === 499,
  );
});
