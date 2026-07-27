import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const maximumLines = 400;
const maximumBytes = 32 * 1024;
const maximumProductionLineLength = 1_000;
const sourceRoots = [
  'index.html',
  'src',
  'scripts',
  'native/pdfkit-helper/Package.swift',
  'native/pdfkit-helper/Sources',
  'native/plugin-worker/Package.swift',
  'native/plugin-worker/Sources',
  'native/plugin-worker/Tests',
  'tests',
  'styles',
];
const sourceExtensions = new Set(['.css', '.html', '.js', '.mjs', '.swift']);

function collectFiles(path) {
  if (!statSync(path).isDirectory()) return sourceExtensions.has(extname(path)) ? [path] : [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return collectFiles(child);
      return sourceExtensions.has(extname(child)) ? [child] : [];
    });
}

function sourceMetrics(path) {
  const value = readFileSync(path, 'utf8');
  if (!value) return { bytes: 0, lines: 0, maximumLineLength: 0 };
  const sourceLines = value.split(/\r?\n/u);
  return {
    bytes: Buffer.byteLength(value, 'utf8'),
    lines: value.endsWith('\n') ? sourceLines.length - 1 : sourceLines.length,
    maximumLineLength: Math.max(...sourceLines.map((line) => line.length)),
  };
}

test('repository code, tests, and styles stay below the monolith boundary', () => {
  const files = sourceRoots.flatMap((path) => collectFiles(join(root, path)));
  const oversized = files
    .map((path) => ({ path: relative(root, path), ...sourceMetrics(path) }))
    .filter(({ path, bytes, lines, maximumLineLength }) => lines > maximumLines
      || bytes > maximumBytes
      || maximumLineLength > maximumProductionLineLength)
    .sort((left, right) => right.lines - left.lines || right.bytes - left.bytes
      || left.path.localeCompare(right.path));

  assert.ok(files.length > 100, 'the source-layout guard must cover the full repository surface');
  assert.deepEqual(
    oversized,
    [],
    `Files above the ${maximumLines}-line, ${maximumBytes}-byte, or ${maximumProductionLineLength}-character production-line boundary:\n${oversized
      .map(({ path, lines, bytes, maximumLineLength }) => `- ${path}: ${lines} lines, ${bytes} bytes, max line ${maximumLineLength}`)
      .join('\n')}`,
  );
});
