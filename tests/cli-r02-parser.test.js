import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';

test('R02 local command parsers expose only their bounded surfaces', () => {
  assert.deepEqual(parseCliArguments([
    'convert-postscript-local', 'source.ps', '--output', 'output.pdf',
  ]), { command: 'convert-postscript-local', input: 'source.ps', output: 'output.pdf' });
  assert.deepEqual(parseCliArguments([
    'create-cad-pdf-local', 'source.dxf', '--output', 'output.pdf',
  ]), { command: 'create-cad-pdf-local', input: 'source.dxf', output: 'output.pdf' });
  assert.deepEqual(parseCliArguments([
    'print-to-pdf-local', 'source.txt', '--output', 'output.pdf',
  ]), { command: 'print-to-pdf-local', input: 'source.txt', output: 'output.pdf' });
  assert.deepEqual(parseCliArguments([
    'export-structured-local', 'source.pdf', '--format', 'html', '--output', 'output.html',
  ]), {
    command: 'export-structured-local', input: 'source.pdf',
    format: 'html', output: 'output.html',
  });
  assert.deepEqual(parseCliArguments([
    'optimize-compress-local', 'source.pdf', '--output', 'output.pdf',
  ]), { command: 'optimize-compress-local', input: 'source.pdf', output: 'output.pdf' });
  assert.deepEqual(parseCliArguments([
    'export-page-png-local', 'source.pdf', '--page', '2', '--dpi', '150',
    '--output', 'output.png',
  ]), {
    command: 'export-page-png-local', input: 'source.pdf', page: 2,
    dpi: 150, output: 'output.png',
  });
});

test('R02 local command parsers reject broader formats and missing bounds', () => {
  for (const args of [
    ['convert-postscript-local', 'source.pdf', '--output', 'output.pdf'],
    ['convert-postscript-local', 'source.ps', '--output', 'output.txt'],
    ['create-cad-pdf-local', 'source.json', '--output', 'output.pdf'],
    ['create-cad-pdf-local', 'source.dxf', '--output', 'output.txt'],
    ['print-to-pdf-local', 'source.html', '--output', 'output.pdf'],
    ['print-to-pdf-local', 'source.txt', '--output', 'output.txt'],
    ['export-structured-local', 'source.pdf', '--format', 'text', '--output', 'output.txt'],
    ['export-structured-local', 'source.pdf', '--format', 'xml', '--output', 'output.html'],
    ['optimize-compress-local', 'source.txt', '--output', 'output.pdf'],
    ['export-page-png-local', 'source.pdf', '--page', '1', '--output', 'output.png'],
    ['export-page-png-local', 'source.pdf', '--page', '1', '--dpi', '96', '--output', 'output.png'],
  ]) assert.throws(() => parseCliArguments(args), { code: 'CLI_INVALID_OPTION' });
});

test('R02 promoted capabilities are available only through dedicated source-bound commands', () => {
  for (const capabilityId of [
    'create.postscript-to-pdf',
    'create.cad-to-pdf',
    'create.print-to-pdf',
    'export.text-rtf',
    'export.html-xml',
    'export.images',
    'optimize.compress',
  ]) {
    assert.throws(() => parseCliArguments([
      'professional-capability', '--capability-id', capabilityId,
    ]), { code: 'CLI_DEDICATED_CAPABILITY_ENTRYPOINT' });
  }
});
