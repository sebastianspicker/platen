import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runSpecialistContentCommand } from '../scripts/cli/commands/specialist-content.mjs';

test('specialist-content CLI is direct JSON stdout only', async () => {
  assert.deepEqual(parseCliArguments(['specialist-content', 'input.pdf']), { command: 'specialist-content', input: 'input.pdf' });
  assert.throws(() => parseCliArguments(['specialist-content', 'input.pdf', '--output', 'x.json']), { code: 'CLI_INVALID_OPTION' });
  const events = []; await runSpecialistContentCommand({ specialistContent: { inspect: async () => ({ profile: 'local-pdf-specialist-content-v1', pageCount: 1 }) } }, { input: 'input.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, { cancelled() {}, emit: async (_stdout, value) => events.push(value) }); assert.equal(events[0].profile, 'local-pdf-specialist-content-v1');
});
