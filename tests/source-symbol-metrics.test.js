import assert from 'node:assert/strict';
import test from 'node:test';
import { measureSourceSymbols } from '../scripts/source-symbol-metrics.mjs';

test('symbol metrics ignore literal braces and recognize JavaScript declaration forms', () => {
  const source = [
    'class Example {',
    '  static #privateMethod(',
    '    value,',
    '  ) {',
    '    const regex = /[{}]/u;',
    '    const template = `ignored ${{ value: "}" }.value}`;',
    '    return value + regex.source + template;',
    '  }',
    '}',
    'const arrow = (',
    '  value,',
    ') => {',
    '  return value;',
    '};',
    'function declared(',
    '  { value },',
    ') {',
    '  return value;',
    '}',
  ].join('\n');
  const metrics = measureSourceSymbols(source);
  const summary = metrics.map(({ kind, name, lines }) => ({ kind, name, lines }));

  assert.deepEqual(summary, [
    { kind: 'class', name: 'Example', lines: 9 },
    { kind: 'function', name: 'arrow', lines: 3 },
    { kind: 'function', name: 'declared', lines: 5 },
    { kind: 'method', name: '#privateMethod', lines: 7 },
  ]);
});

test('symbol metrics recognize Swift types and multiline functions', () => {
  const source = [
    'struct Example {',
    '  func render(',
    '    value: String',
    '  ) -> String {',
    '    let ignored = "{"',
    '    return value + ignored',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(
    measureSourceSymbols(source, { language: 'swift' }).map(({ kind, name, lines }) => ({ kind, name, lines })),
    [
      { kind: 'type', name: 'Example', lines: 8 },
      { kind: 'function', name: 'render', lines: 6 },
    ],
  );
});
