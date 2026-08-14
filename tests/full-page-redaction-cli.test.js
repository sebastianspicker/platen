import assert from 'node:assert/strict';
import test from 'node:test';
import { runFullPageRedactionBatchCommand } from '../scripts/cli/commands/full-page-redaction.mjs';
import { FULL_PAGE_REDACTION_BATCH_PROFILE } from '../scripts/host/pdf-full-page-redaction-writer.mjs';

test('redact-pages CLI invokes one atomic batch and publishes exclusively', async () => {
  const calls = [];
  const application = {
    fullPageRedaction: { updateBatch: async (...args) => { calls.push(args); return { kind: 'pdf-full-page-redaction-batch', artifact: { id: 'artifact' } }; } },
    store: { getArtifact: () => ({ filePath: '/private/redacted.pdf' }) },
  };
  await runFullPageRedactionBatchCommand(application, { pages: [1, 3, 4], output: '/tmp/output.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, {
    cancelled() {}, copyExclusive: (...args) => calls.push(args), emit: async () => {}, canonicalOutputTarget: async () => {},
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  });
  assert.equal(calls[0][0], 'doc');
  assert.deepEqual(calls[0][1], { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: 'a'.repeat(64), pages: [1, 3, 4] });
  assert.deepEqual(calls[1], ['/private/redacted.pdf', '/tmp/output.pdf']);
});
