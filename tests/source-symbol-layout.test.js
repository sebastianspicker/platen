import assert from 'node:assert/strict';
import { dirname, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectProductionSources,
  collectTestSources,
  sourceSymbolMetrics,
} from '../scripts/source-symbol-metrics.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const maximumFunctionLines = 120;
const maximumClassLines = 300;

test('production functions, methods, and types stay below the monolith boundary', () => {
  const files = collectProductionSources(root);
  const oversized = files.flatMap((path) => sourceSymbolMetrics(path)
    .filter(({ kind, lines }) => (
      kind === 'function' || kind === 'method'
        ? lines > maximumFunctionLines
        : lines > maximumClassLines
    ))
    .map((metric) => ({ path: relative(root, path), ...metric })))
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));

  assert.ok(files.length > 150, 'the symbol-layout guard must cover the production source surface');
  assert.deepEqual(
    oversized,
    [],
    `Symbols above the ${maximumFunctionLines}-line function/method or ${maximumClassLines}-line type boundary:\n${oversized
      .map(({ path, kind, name, startLine, endLine, lines }) => (
        `- ${path}:${startLine}-${endLine} ${kind} ${name}: ${lines} lines`
      ))
      .join('\n')}`,
  );
});

test('test callbacks, helpers, and fixture types stay below the monolith boundary', () => {
  const files = collectTestSources(root);
  const oversized = files.flatMap((path) => sourceSymbolMetrics(path)
    .filter(({ kind, lines }) => (
      kind === 'function' || kind === 'method'
        ? lines > maximumFunctionLines
        : lines > maximumClassLines
    ))
    .map((metric) => ({ path: relative(root, path), ...metric })))
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));

  assert.ok(files.length > 150, 'the symbol-layout guard must cover the test source surface');
  assert.deepEqual(
    oversized,
    [],
    `Test symbols above the ${maximumFunctionLines}-line callback/helper or ${maximumClassLines}-line type boundary:\n${oversized
      .map(({ path, kind, name, startLine, endLine, lines }) => (
        `- ${path}:${startLine}-${endLine} ${kind} ${name}: ${lines} lines`
      ))
      .join('\n')}`,
  );
});
