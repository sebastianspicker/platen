import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAutomationCliBatch } from '../scripts/cli/parser-automation-batch.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { AUTOMATION_PRESET_IDS } from '../scripts/host/automation/automation-operation-contract.mjs';

function parse(inputs, entries = []) {
  return parseAutomationCliBatch('automation-submit-batch', inputs, new Map([
    ['automation-root', 'private-automation'], ['idempotency-key', 'batch-identity'], ...entries,
  ]), null);
}

test('automation-submit-batch accepts the fixed operation and preset selections', () => {
  for (const operation of ['inspect', 'ocr', 'output-intent']) {
    const parsed = parse(['one.pdf', 'two.pdf'], [['operation', operation]]);
    assert.equal(parsed.operation, operation);
    assert.deepEqual(parsed.inputs, ['one.pdf', 'two.pdf']);
    assert.equal(Object.isFrozen(parsed), true);
  }
  const redaction = parse(['one.pdf', 'two.pdf'], [['operation', 'full-page-redaction'], ['pages', '3,1-2']]);
  assert.deepEqual(redaction.pages, [1, 2, 3]);
  for (const preset of AUTOMATION_PRESET_IDS) {
    const parsed = parse(['one.pdf', 'two.pdf'], [['preset', preset]]);
    assert.equal(parsed.preset, preset);
    assert.equal(parsed.operation, undefined);
  }
});

test('automation-submit-batch rejects hostile, ambiguous, and unsupported input', () => {
  const invalid = [
    [[], [['operation', 'inspect']]],
    [['one.pdf'], [['operation', 'inspect']]],
    [['one.pdf', 'two.pdf', 'three.pdf', 'four.pdf', 'five.pdf', 'six.pdf', 'seven.pdf', 'eight.pdf', 'nine.pdf'], [['operation', 'inspect']]],
    [['one.pdf', 'one.pdf'], [['operation', 'inspect']]],
    [['one.txt', 'two.pdf'], [['operation', 'inspect']]],
    [['one.pdf', 'two.pdf'], []],
    [['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['preset', AUTOMATION_PRESET_IDS[0]]]],
    [['one.pdf', 'two.pdf'], [['operation', 'unknown']]],
    [['one.pdf', 'two.pdf'], [['preset', 'unknown']]],
    [['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['pages', '1']]],
    [['one.pdf', 'two.pdf'], [['operation', 'ocr'], ['pages', '1']]],
    [['one.pdf', 'two.pdf'], [['operation', 'full-page-redaction']]],
    [['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['language', 'eng']]],
  ];
  for (const [inputs, entries] of invalid) assert.throws(() => parse(inputs, entries), { code: /^CLI_INVALID/u });
  assert.throws(() => parse(['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['idempotency-key', '']]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parse(['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['idempotency-key', 'x'.repeat(257)]]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parse(['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['idempotency-key', 'unsafe\0identity']]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parse(['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['idempotency-key', 'unsafe\nidentity']]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parse(['one.pdf', 'two.pdf'], [['operation', 'inspect'], ['idempotency-key', 'e\u0301']]), { code: 'CLI_INVALID_OPTION' });
});

test('top-level CLI parsing preserves batch option isolation and positional mode', () => {
  const parsed = parseCliArguments([
    'automation-submit-batch',
    '--automation-root', 'private-automation',
    '--idempotency-key', 'batch-identity',
    '--operation', 'inspect',
    '--', 'one.pdf', 'two.pdf',
  ]);
  assert.deepEqual(parsed.inputs, ['one.pdf', 'two.pdf']);
  assert.throws(() => parseCliArguments([
    'automation-submit-batch', 'one.pdf', 'two.pdf',
    '--automation-root', 'private-automation',
    '--idempotency-key', 'batch-identity',
    '--operation', 'inspect',
    '--worker-id', 'confused',
  ]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments([
    'automation-submit-batch', 'one.pdf', 'two.pdf',
    '--automation-root', 'private-automation',
    '--idempotency-key', 'batch-identity',
    '--operation', 'inspect',
    '--operation', 'ocr',
  ]), { code: 'CLI_INVALID_OPTION' });
});
