import assert from 'node:assert/strict'; import test from 'node:test'; import { runTaggedRemediationCommand } from '../scripts/cli/commands/tagged-remediation.mjs';
test('tagged CLI reads bounded canonical plan and publishes exclusive artifact', async () => {
  const source = JSON.stringify({
    plan: { id: 'document', role: 'Document', children: [{ id: 'p', role: 'P', page: 1, contentIndex: 0 }] },
    language: null, title: null, roleMap: {},
  }); const copied = [];
  const app = {
    taggedRemediation: { update: async (id, request) => {
      assert.equal(id, 'doc'); assert.equal(request.sourceSha256, 'a'.repeat(64));
      return { artifact: { id: 'a' }, limitations: ['not reading order'] };
    } },
    store: { getArtifact: () => ({ filePath: '/private/tagged.pdf' }) },
  };
  await runTaggedRemediationCommand(app, { planPath: 'plan.json', output: '/tmp/tagged.pdf' },
    { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, {
      readLocalInputBytes: async () => ({ bytes: Buffer.from(source) }),
      fail(code) { throw Object.assign(new Error(code), { code }); }, cancelled() {},
      copyExclusive: async (...args) => copied.push(args), emit: async () => {},
    });
  assert.deepEqual(copied, [['/private/tagged.pdf', '/tmp/tagged.pdf']]);
});
test('tagged CLI rejects malformed plan before service invocation', async () => { await assert.rejects(runTaggedRemediationCommand({}, { planPath: 'plan.json', output: 'out.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, { readLocalInputBytes: async () => ({ bytes: Buffer.from('{}') }), fail(code) { throw Object.assign(new Error(code), { code }); } }), { code: 'CLI_INVALID_PLAN' }); });
test('tagged CLI preserves bounded plan-file input failures', async () => { for (const code of ['CLI_INVALID_INPUT', 'CLI_INPUT_TOO_LARGE']) await assert.rejects(runTaggedRemediationCommand({}, { planPath: 'plan.json', output: 'out.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, null, undefined, { readLocalInputBytes: async () => { throw Object.assign(new Error(code), { code }); } }), { code }); });
