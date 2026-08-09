import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments, CLI_HELP } from '../scripts/cli/parser.mjs';
import { AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES } from '../scripts/host/automation/automation-conditional-workflow-contract.mjs';

const base = [
  'automation-run-conditional', 'INPUT.pdf', '--workflow', 'WORKFLOW.json',
  '--automation-root', 'automation', '--idempotency-key', 'request-1', '--output', 'report.json',
];

test('automation-run-conditional returns the exact frozen command shape', () => {
  const parsed = parseCliArguments(base);
  assert.deepEqual(parsed, {
    command: 'automation-run-conditional',
    input: 'INPUT.pdf',
    automationRoot: 'automation',
    workflow: 'WORKFLOW.json',
    idempotencyKey: 'request-1',
    output: 'report.json',
  });
  assert.deepEqual(Object.keys(parsed), [
    'command', 'input', 'automationRoot', 'workflow', 'idempotencyKey', 'output',
  ]);
  assert.equal(Object.isFrozen(parsed), true);
});

test('automation-run-conditional defaults idempotency key to null', () => {
  assert.deepEqual(parseCliArguments([
    'automation-run-conditional', 'INPUT.PDF', '--workflow', 'workflow.json', '--automation-root', 'automation',
  ]), {
    command: 'automation-run-conditional',
    input: 'INPUT.PDF',
    automationRoot: 'automation',
    workflow: 'workflow.json',
    idempotencyKey: null,
    output: null,
  });
  assert.doesNotThrow(() => parseCliArguments([
    ...base.slice(0, 6), '--idempotency-key', 'x'.repeat(AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES),
  ]));
});

test('automation-run-conditional rejects hostile and unsupported arguments', () => {
  const invalid = [
    ['automation-run-conditional', '--workflow', 'workflow.json', '--automation-root', 'automation'],
    ['automation-run-conditional', 'one.pdf', 'two.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation'],
    ['automation-run-conditional', 'input.txt', '--workflow', 'workflow.json', '--automation-root', 'automation'],
    ['automation-run-conditional', 'input.pdf', '--automation-root', 'automation'],
    ['automation-run-conditional', 'input.pdf', '--workflow', '', '--automation-root', 'automation'],
    ['automation-run-conditional', 'input.pdf', '--workflow', `x${'a'.repeat(4096)}.json`, '--automation-root', 'automation'],
    ['automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation', '--idempotency-key', ''],
    ['automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation', '--idempotency-key', 'x'.repeat(AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES + 1)],
    ['automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation', '--idempotency-key', 'safe\u0000key'],
    ['automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation', '--idempotency-key', 'safe\u007fkey'],
    ['automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation', '--recipe', 'inspect-document-v1'],
    ['automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json', '--automation-root', 'automation', '--scripts', 'run.js'],
  ];
  for (const args of invalid) assert.throws(() => parseCliArguments(args), { code: /^CLI_INVALID/ });
  assert.throws(() => parseCliArguments([
    'automation-run-conditional', 'input.pdf', '--workflow', 'workflow.json',
  ]), { code: 'CLI_INVALID_OPTION' });
});

test('automation-run-conditional help describes bounded local declarative workflows', () => {
  assert.match(CLI_HELP, /automation-run-conditional INPUT\.pdf --workflow WORKFLOW\.json/u);
  assert.match(CLI_HELP, /verified local document facts/u);
  assert.match(CLI_HELP, /allowlisted operations/u);
  assert.match(CLI_HELP, /no code\/expression engine/u);
});
