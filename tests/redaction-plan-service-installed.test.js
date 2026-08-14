import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ImageMagickAdapter } from '../scripts/host/adapters/imagemagick.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { RasterMutationAdapter } from '../scripts/host/adapters/raster-mutation.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { RasterMutationService } from '../scripts/host/raster-mutation-service.mjs';
import { RedactionPlanService } from '../scripts/host/redaction-plan-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const ENGINES = [
  '/opt/homebrew/bin/pdfinfo',
  '/opt/homebrew/bin/pdftotext',
  '/opt/homebrew/bin/pdftocairo',
  '/opt/homebrew/bin/pdfdetach',
  '/opt/homebrew/bin/pdfsig',
  '/opt/homebrew/bin/magick',
];

test('installed engines carry a source-bound proposal into a private verified artifact', async (context) => {
  try {
    await Promise.all(ENGINES.map((path) => access(path)));
  } catch {
    context.skip('Fixed Poppler and ImageMagick tools are unavailable.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'redaction-plan-installed-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store);
  const registry = new EngineRegistry();
  const poppler = new PopplerAdapter({ registry });
  const rasterMutations = new RasterMutationService({
    store,
    poppler,
    imageMagick: new ImageMagickAdapter({ registry }),
    raster: new RasterMutationAdapter({ registry }),
  });
  const plans = new RedactionPlanService({
    documentStore: store,
    workspaceStateStore: workspace,
    poppler,
    rasterMutations,
    bindingKey: Buffer.alloc(32, 19),
    clock: () => '2026-07-19T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}-installed`,
  });
  const secret = 'SOURCE BOUND INSTALLED SECRET';
  const sourceBytes = makeTextPdf(secret);
  const source = await store.createDocument({
    stream: Readable.from([sourceBytes]),
    displayName: 'installed-secret.pdf',
  });
  const created = await plans.createPlan(source.id, {
    schemaVersion: 1,
    profile: 'source-bound-redaction-plan-v1',
    sourceSha256: source.sha256,
    expectedWorkspaceRevision: 0,
    targets: [{ page: 1, fullPage: true }],
  });
  const applied = await plans.applyPlan(source.id, {
    schemaVersion: 1,
    profile: 'source-bound-redaction-application-v1',
    sourceSha256: source.sha256,
    expectedWorkspaceRevision: created.revision,
    planId: created.plan.id,
    planSha256: created.plan.planSha256,
    markIds: [created.plan.marks[0].id],
  });

  const serialized = JSON.stringify({ created, applied, workspace: workspace.snapshot(source.id) });
  assert.equal(serialized.includes(secret), false);
  assert.equal(applied.application.status, 'artifact-created');
  assert.equal(applied.application.planStatus, 'proposed-not-applied');
  assert.equal(applied.artifact.operation.parameters.planBinding.planId, created.plan.id);
  assert.deepEqual(applied.artifact.operation.parameters.planBinding.markIds, [created.plan.marks[0].id]);
  assert.equal(applied.artifact.operation.validation.sensitiveTextRetained, false);
  assert.deepEqual(await readFile(store.getSourcePath(source.id)), sourceBytes);
  assert.equal(await store.verifySource(source.id), true);
  assert.equal(workspace.snapshot(source.id).namespaces.redactions[0].status, 'proposed-not-applied');
});
