import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments, CLI_HELP } from '../scripts/cli/parser.mjs';
import { AUTOMATION_JS_MAX_REPEATS } from '../scripts/host/automation/automation-js-contract.mjs';
import { AUTOMATION_JS_RECIPE_IDS } from '../scripts/host/automation/automation-js-registry.mjs';

const recipe = AUTOMATION_JS_RECIPE_IDS[0];

test('automation-run-recipe returns the exact frozen command shape', () => {
  const parsed = parseCliArguments([
    'automation-run-recipe', 'INPUT.pdf', '--recipe', recipe,
    '--automation-root', 'automation', '--repeat', String(AUTOMATION_JS_MAX_REPEATS),
    '--idempotency-key', 'request-1', '--output', 'report.json',
  ]);
  assert.deepEqual(parsed, {
    command: 'automation-run-recipe',
    input: 'INPUT.pdf',
    automationRoot: 'automation',
    recipe,
    repeat: AUTOMATION_JS_MAX_REPEATS,
    idempotencyKey: 'request-1',
    output: 'report.json',
  });
  assert.deepEqual(Object.keys(parsed), [
    'command', 'input', 'automationRoot', 'recipe', 'repeat', 'idempotencyKey', 'output',
  ]);
  assert.equal(Object.isFrozen(parsed), true);
});

test('automation-run-recipe defaults repeat and idempotency key', () => {
  assert.deepEqual(parseCliArguments([
    'automation-run-recipe', 'INPUT.pdf', '--recipe', recipe, '--automation-root', 'automation',
  ]), {
    command: 'automation-run-recipe',
    input: 'INPUT.pdf',
    automationRoot: 'automation',
    recipe,
    repeat: 1,
    idempotencyKey: null,
    output: null,
  });
});

test('automation-run-recipe rejects hostile and unsupported arguments', () => {
  const invalid = [
    ['automation-run-recipe', '--recipe', recipe, '--automation-root', 'automation'],
    ['automation-run-recipe', 'one.pdf', 'two.pdf', '--recipe', recipe, '--automation-root', 'automation'],
    ['automation-run-recipe', 'one.pdf', '--recipe', 'unknown-recipe', '--automation-root', 'automation'],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--repeat', '0'],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--repeat', String(AUTOMATION_JS_MAX_REPEATS + 1)],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--repeat', '1.5'],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--idempotency-key', ''],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--idempotency-key', 'x'.repeat(257)],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--idempotency-key', 'safe\u0000key'],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--scripts', 'run.js'],
    ['automation-run-recipe', 'one.pdf', '--recipe', recipe, '--automation-root', 'automation', '--operation', 'inspect'],
  ];
  for (const args of invalid) assert.throws(() => parseCliArguments(args), { code: /^CLI_INVALID/ });
});

test('automation-run-recipe help describes fixed declarative recipes', () => {
  assert.match(CLI_HELP, /automation-run-recipe INPUT\.pdf --recipe RECIPE_ID/u);
  assert.match(CLI_HELP, /fixed, allowlisted declarative/u);
  assert.doesNotMatch(CLI_HELP, /executes JavaScript|accepts scripts/u);
});
