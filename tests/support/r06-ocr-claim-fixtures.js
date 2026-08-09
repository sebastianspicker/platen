import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DocumentStore } from '../../scripts/host/document-store.mjs';
import { EngineRegistry } from '../../scripts/host/engine-registry.mjs';
import { OcrImageAdapter } from '../../scripts/host/adapters/ocr-image.mjs';
import { PopplerAdapter } from '../../scripts/host/adapters/poppler.mjs';
import { TesseractAdapter } from '../../scripts/host/adapters/tesseract.mjs';
import { PdfService } from '../../scripts/host/pdf-service.mjs';
import { makeTextPdf } from '../pdf-fixture.js';

export const OCR_ENGINE_PATHS = Object.freeze([
  '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext',
  '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfunite',
  '/opt/homebrew/bin/tesseract', '/opt/homebrew/bin/magick',
]);

export async function enginesAvailable() {
  try {
    await Promise.all(OCR_ENGINE_PATHS.map((path) => access(path)));
    return true;
  } catch {
    return false;
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function createRealOcrFixture(text = 'R06 OCR SOURCE') {
  const root = await mkdtemp(join(tmpdir(), 'platen-r06-ocr-'));
  const store = await new DocumentStore({ root }).initialize();
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const service = new PdfService({
    store,
    registry,
    adapter,
    ocrAdapter: new TesseractAdapter({ registry }),
    ocrImageAdapter: new OcrImageAdapter({ registry }),
  });
  const source = await store.createDocument({
    stream: Readable.from([makeTextPdf(text)]),
    displayName: 'r06-source.pdf',
  });
  return {
    root,
    store,
    service,
    source,
    async cleanup() {
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function readArtifact(store, artifact) {
  const authoritative = store.getArtifact(artifact.id);
  const bytes = await readFile(authoritative.filePath);
  return { authoritative, bytes };
}

export async function driftSource(store, documentId, bytes = Buffer.from('R06 SOURCE DRIFT')) {
  await writeFile(store.getSourcePath(documentId), bytes, { mode: 0o600 });
}
