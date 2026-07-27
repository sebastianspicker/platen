import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfCompositionService } from '../scripts/host/pdf-composition-service.mjs';
import { HostError } from '../scripts/host/host-error.mjs';

async function fixture({ failFinalVerification = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-composition-service-test-'));
  const primaryId = '11111111-1111-4111-8111-111111111111';
  const secondaryId = '22222222-2222-4222-8222-222222222222';
  const sourcePaths = new Map([[primaryId, join(root, 'primary.pdf')], [secondaryId, join(root, 'secondary.pdf')]]);
  await Promise.all([...sourcePaths.values()].map((path) => writeFile(path, 'source')));
  const sourcePageCounts = new Map([[primaryId, 3], [secondaryId, 2]]);
  const outputPageCounts = new Map();
  const events = [];
  let verificationCount = 0;
  const store = {
    getDocument(documentId) { return { displayName: documentId === primaryId ? 'primary.pdf' : 'secondary.pdf', sha256: documentId[0].repeat(64) }; },
    getSourcePath(documentId) { return sourcePaths.get(documentId); },
    async verifySource(documentId) {
      events.push(`verify:${documentId}`);
      verificationCount += 1;
      if (failFinalVerification && verificationCount >= 2) throw new HostError('SOURCE_CHANGED', 'Source changed during composition.', 409);
      return true;
    },
    async createJobWorkspace() { return mkdtemp(join(root, 'job-')); },
    async cleanupJob(workspace) { events.push('cleanup'); await rm(workspace, { recursive: true, force: true }); },
    async promotePdfArtifact(documentId, filePath, options) {
      events.push('promote');
      return { id: 'artifact', documentId, displayName: options.displayName, operation: options.operation, filePath };
    },
  };
  const adapter = {
    async execute(operation, parameters) {
      if (operation === 'splitPages') {
        const output = parameters.outputPattern.replace('%d', String(parameters.firstPage));
        events.push(`split:${parameters.input}:${parameters.firstPage}`);
        outputPageCounts.set(output, 1);
        await writeFile(output, `page ${parameters.firstPage}`);
        return { stdout: '' };
      }
      if (operation === 'mergeDocuments') {
        events.push(`merge:${parameters.inputs.length}`);
        outputPageCounts.set(parameters.output, parameters.inputs.reduce((count, input) => count + outputPageCounts.get(input), 0));
        await writeFile(parameters.output, 'merged');
        return { stdout: '' };
      }
      assert.equal(operation, 'inspect');
      const pages = outputPageCounts.get(parameters.input);
      assert.ok(pages, 'only derived files are inspected by output validation');
      events.push(`inspect:${pages}`);
      return { stdout: `Pages: ${pages}\n` };
    },
  };
  const inspection = { async inspect(documentId) { return { pageCount: sourcePageCounts.get(documentId) }; } };
  return {
    service: new PdfCompositionService({ store, adapter, inspection }), events, primaryId, secondaryId,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('synthetic composition preserves interleave selection order and validates one merged output', async (context) => {
  const setup = await fixture();
  context.after(setup.dispose);
  const artifact = await setup.service.interleaveDocuments(setup.primaryId, setup.secondaryId);
  assert.equal(artifact.displayName, 'primary-interleaved.pdf');
  assert.deepEqual(
    setup.events.filter((event) => event.startsWith('split:'))
      .map((event) => event.replace(/^split:.*\/(primary|secondary)\.pdf:(\d+)$/u, '$1:$2')),
    ['primary:1', 'secondary:1', 'primary:2', 'secondary:2', 'primary:3'],
  );
  assert.equal(setup.events.includes('merge:5'), true);
  assert.equal(setup.events.includes('inspect:5'), true);
  assert.equal(setup.events.at(-1), 'cleanup');
});

test('synthetic composition rejects a source swap during final source binding validation', async (context) => {
  const setup = await fixture({ failFinalVerification: true });
  context.after(setup.dispose);
  await assert.rejects(setup.service.extractPages(setup.primaryId, [1]), { code: 'SOURCE_CHANGED', status: 409 });
  assert.equal(setup.events.includes('promote'), false);
  assert.equal(setup.events.at(-1), 'cleanup');
});
