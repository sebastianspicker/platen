import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EngineRegistry } from '../../scripts/host/engine-registry.mjs';
import { DocumentStore } from '../../scripts/host/document-store.mjs';
import { PopplerAdapter } from '../../scripts/host/adapters/poppler.mjs';
import { PdfService } from '../../scripts/host/pdf-service.mjs';
import { PdfOoxmlExportService } from '../../scripts/host/pdf-ooxml-export.mjs';
import { createTextPdf } from '../../scripts/host/pdf-factory.mjs';

export async function createR02SourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'platen-r02-existing-authority-'));
  const store = await new DocumentStore({ root }).initialize();
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const service = new PdfService({ store, registry, adapter });
  const source = await store.createDocument({
    stream: Readable.from([createTextPdf({
      pages: ['R02 source page one\nClipboard-safe text', 'R02 source page two'],
      title: 'R02 source fixture',
    })]),
    displayName: 'r02-source.pdf',
  });
  const ooxmlExport = new PdfOoxmlExportService({
    store,
    extractor: {
      inspect: async (documentId, options) => ({
        pageCount: (await service.inspect(documentId, options)).pageCount,
      }),
      extractText: async (documentId, pageCount, options) => ({
        sourceDigest: store.getDocument(documentId).sha256,
        pageCount,
        pages: await service.extractText(documentId, pageCount, options),
      }),
    },
  });
  return Object.freeze({
    root,
    store,
    registry,
    adapter,
    service,
    ooxmlExport,
    source,
    async dispose() {
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    },
  });
}
