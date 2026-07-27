import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { createBlankPdf, createTextPdf } from '../scripts/host/pdf-factory.mjs';

test('local PDF factory creates bounded blank and text documents', () => {
  const blank = createBlankPdf({ pages: 2, widthPoints: 595, heightPoints: 842, title: 'Blank' });
  const textPdf = createTextPdf({ pages: ['First page', 'Second (page)'], title: 'Text' });
  assert.equal(blank.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(textPdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(textPdf.toString('binary').includes('Second \\(page\\)'), true);
  assert.throws(() => createBlankPdf({ pages: 0 }), { code: 'INVALID_PAGE_COUNT' });
  assert.throws(() => createBlankPdf({ widthPoints: 20 }), { code: 'INVALID_PAGE_SIZE' });
});

test('installed Poppler validates factory page count, dimensions, and extracted text', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('Poppler inspection tools are unavailable.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-factory-test-'));
  const path = join(root, 'factory.pdf');
  await writeFile(path, createTextPdf({ pages: ['Alpha', 'Beta'], widthPoints: 612, heightPoints: 792 }));
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const info = await adapter.execute('inspect', { input: path });
  const text = await adapter.execute('extractText', { input: path, layout: false });
  assert.match(info.stdout, /Pages:\s+2/);
  assert.match(info.stdout, /612 x 792 pts/);
  assert.match(text.stdout, /Alpha[\s\S]*Beta/);
});
