import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { ComparisonService } from '../scripts/host/comparison-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { createComparisonEndpoints } from '../src/core/local-host-comparison-endpoints.js';
import { makeTextPdf } from './pdf-fixture.js';

test('installed Poppler side-by-side panes are canonical RGBA PNGs accepted by the local client', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Poppler render toolchain is not installed.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-side-by-side-poppler-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const pdf = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const primary = await store.createDocument({ stream: Readable.from([makeTextPdf('PRIMARY')]), displayName: 'primary.pdf' });
  const secondary = await store.createDocument({ stream: Readable.from([makeTextPdf('SECONDARY')]), displayName: 'secondary.pdf' });
  const service = new ComparisonService({ store, pdfService: pdf });
  const client = createComparisonEndpoints({
    json: async (_path, options) => {
      const request = JSON.parse(options.body);
      return { report: await service.describeSideBySide(primary.id, request.secondaryDocumentId, request.options) };
    },
  });
  const report = await client.compareDocuments(primary.id, secondary.id, 'side-by-side', { page: 1 });
  assert.deepEqual(report.panes.map(({ role }) => role), ['primary', 'secondary']);
  for (const pane of report.panes) {
    const bytes = Buffer.from(pane.data, 'base64');
    assert.equal(bytes[24], 8);
    assert.equal(bytes[25], 6);
  }
});
