import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTesseractLanguagesArgs,
  buildTesseractLayoutArgs,
  buildTesseractPdfArgs,
  TesseractAdapter,
  validateOcrLanguage,
} from '../scripts/host/adapters/tesseract.mjs';

test('Tesseract builders expose fixed local OCR operations', () => {
  assert.deepEqual(buildTesseractLanguagesArgs(), ['--list-langs']);
  assert.deepEqual(buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/ocr-page', language: 'eng+deu' }), [
    '/jobs/page.png', '/jobs/ocr-page', '-l', 'eng+deu', '--psm', '3', '-c', 'preserve_interword_spaces=1', 'pdf', 'tsv',
  ]);
  assert.deepEqual(buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/ocr-page', language: 'eng', userWordsPath: '/private/job/ocr-user-words.txt' }), [
    '/jobs/page.png', '/jobs/ocr-page', '-l', 'eng', '--psm', '3', '-c', 'preserve_interword_spaces=1', '--user-words', '/private/job/ocr-user-words.txt', 'pdf', 'tsv',
  ]);
  assert.deepEqual(buildTesseractLayoutArgs({
    input: '/jobs/page.png', outputBase: '/jobs/layout', language: 'eng', dpi: 300,
    segmentation: 'single-column', detectTables: true,
  }), [
    '/jobs/page.png', '/jobs/layout', '-l', 'eng', '--dpi', '300', '--psm', '4',
    '-c', 'preserve_interword_spaces=1', '-c', 'textord_tabfind_find_tables=1',
    '-c', 'textord_tablefind_recognize_tables=1', 'tsv', 'alto',
  ]);
  assert.equal(validateOcrLanguage('eng'), 'eng');
});

test('Tesseract builders reject paths and language injection', () => {
  assert.throws(() => buildTesseractPdfArgs({ input: 'page.png', outputBase: '/jobs/out', language: 'eng' }), /absolute path/);
  assert.throws(() => buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng --psm 1' }), /language/);
  assert.throws(() => validateOcrLanguage('eng+deu+fra+ita+spa+por+nld+dan+nor'), /one to eight/);
  assert.throws(() => buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', segmentation: '3 --user-words' }), /segmentation/);
  assert.throws(() => buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', segmentation: 'toString' }), /segmentation/);
  assert.throws(() => buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', segmentation: 'constructor' }), /segmentation/);
  assert.throws(() => buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', segmentation: '__proto__' }), /segmentation/);
  assert.throws(() => buildTesseractPdfArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', userWordsPath: 'words.txt' }), /absolute path/);
  assert.throws(() => buildTesseractLayoutArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', dpi: 1200 }), /dpi/);
  assert.throws(() => buildTesseractLayoutArgs({ input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng', detectTables: 'true' }), /detectTables/);
});

test('Tesseract adapter pins executable and validated argv', async () => {
  const calls = [];
  const adapter = new TesseractAdapter({
    registry: { probe: async (name) => ({ name, executable: '/engines/tesseract', version: '5.5.2' }) },
    runner: async (invocation) => { calls.push(invocation); return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  await adapter.execute('recognizePagePdf', { input: '/jobs/page.png', outputBase: '/jobs/out', language: 'eng' }, { timeoutMs: 10_000, executable: '/evil' });
  assert.deepEqual(calls, [{
    timeoutMs: 10_000,
    executable: '/engines/tesseract',
    args: ['/jobs/page.png', '/jobs/out', '-l', 'eng', '--psm', '3', '-c', 'preserve_interword_spaces=1', 'pdf', 'tsv'],
  }]);
});

test('Tesseract adapter rejects inherited operation names before probing or running', async () => {
  let probes = 0; let runs = 0;
  const adapter = new TesseractAdapter({
    registry: { probe: async () => { probes += 1; return { executable: '/engines/tesseract' }; } },
    runner: async () => { runs += 1; },
  });
  for (const operation of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(adapter.execute(operation), /Unknown Tesseract operation/);
  }
  assert.equal(probes, 0);
  assert.equal(runs, 0);
});
