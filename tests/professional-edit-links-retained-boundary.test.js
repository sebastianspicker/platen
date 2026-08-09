import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { buildClassicPassivePdf } from '../scripts/host/professional-capability/classic-structure-pdf.mjs';
import {
  INCREMENTAL_GOTO_LINK_LIMITATIONS,
  INCREMENTAL_GOTO_LINK_PROFILE,
  INCREMENTAL_GOTO_LINK_VALIDATORS,
  validateIncrementalGoToLinkResult,
} from '../src/core/pdf-incremental-goto-link-contract.js';
import { writeIncrementalPdfGoToLink } from '../scripts/host/pdf-incremental-goto-link-writer.mjs';
import { handlers } from '../scripts/host/professional-capability/content-editing.mjs';

const documentId = '55555555-5555-4555-8555-555555555555';
const SOURCE_PAGE = 1;
const TARGET_PAGE = 1;
const LINK_RECT = { left: 72, bottom: 700, right: 200, top: 760 };

function sourceBoundEditContext({ serviceRequest, readArtifact, deleteFailure = false, readFailure, signal } = {}) {
  const source = buildClassicPassivePdf({ pages: 2 });
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const request = {
    profile: INCREMENTAL_GOTO_LINK_PROFILE,
    sourcePage: SOURCE_PAGE,
    targetPage: TARGET_PAGE,
    rect: LINK_RECT,
  };
  const proof = writeIncrementalPdfGoToLink(source, request).proof;
  const output = writeIncrementalPdfGoToLink(source, request).bytes;
  const outputSha256 = createHash('sha256').update(output).digest('hex');
  const artifact = {
    id: randomUUID(),
    documentId,
    mediaType: 'application/pdf',
    size: output.length,
    sha256: outputSha256,
    displayName: 'incremental-goto-link.pdf',
    operation: {
      schemaVersion: 1,
      id: randomUUID(),
      type: 'pdf-incremental-goto-link',
      inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
      parameters: {
        profile: INCREMENTAL_GOTO_LINK_PROFILE,
        sourcePage: SOURCE_PAGE,
        targetPage: TARGET_PAGE,
        rect: LINK_RECT,
      },
      expected: {
        pageCount: 2,
        sourceUnchanged: true,
        sourcePrefixPreserved: true,
        classicIncrementalRevisionAppended: true,
        rasterized: false,
      },
      validation: {
        passed: true,
        validators: INCREMENTAL_GOTO_LINK_VALIDATORS,
        pageCount: 2,
        outputSha256,
      },
      completedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const defaultReceipt = {
    kind: 'pdf-incremental-goto-link',
    sourceDigest: sourceSha256,
    artifact,
    link: {
      sourcePage: request.sourcePage,
      targetPage: request.targetPage,
      rect: request.rect,
    },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      classicIncrementalRevisionAppended: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageBoxesMatched: true,
      pageValidationRendersMatched: true,
      outputUnsigned: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: INCREMENTAL_GOTO_LINK_LIMITATIONS,
  };
  validateIncrementalGoToLinkResult(defaultReceipt, {
    documentId,
    sourceSha256,
    request,
  });
  const calls = { update: 0, readArtifact: 0, deleteArtifact: 0 };
  return {
    source,
    sourceSha256,
    output,
    artifact,
    calls,
    context: {
      documentId,
      sourcePdf: source,
      sourceSha256,
      fromPage: SOURCE_PAGE,
      toPage: TARGET_PAGE,
      rect: serviceRequest?.rect,
      incrementalGoToLink: {
        async update(targetId, targetRequest, options) {
          calls.update += 1;
          calls.lastUpdate = { targetId, targetRequest, options };
          if (serviceRequest) {
            Object.entries(serviceRequest).forEach(([name, value]) => assert.deepEqual(targetRequest[name], value));
          }
          return serviceRequest?.receipt ?? defaultReceipt;
        },
      },
      readArtifact: async () => {
        calls.readArtifact += 1;
        if (readFailure) throw readFailure;
        if (readArtifact) return readArtifact();
        return output;
      },
      signal,
      store: {
        async deleteArtifact(id) {
          calls.deleteArtifact += 1;
          assert.equal(id, artifact.id);
          if (deleteFailure) {
            throw new Error('delete failed');
          }
        },
      },
    },
  };
}

test('edit.links production boundary success rereads retained artifact and validates bound request', async () => {
  const context = sourceBoundEditContext();
  const result = await handlers['edit.links'](context.context);
  assert.equal(result.method, 'production-incremental-goto-link-service');
  assert.equal(result.productionMode, true);
  assert.equal(result.retainedBoundaryValidated, true);
  assert.equal(result.trustBoundary.productionService, true);
  assert.equal(result.trustBoundary.artifactReread, true);
  assert.equal(result.localOnly, true);
  assert.equal(result.sourceSha256, context.sourceSha256);
  assert.equal(result.outputSha256, context.artifact.sha256);
  assert.equal(result.bytes, context.output.length);
  assert.equal(result.proof.sourceBytes, context.source.length);
  assert.equal(result.proof.rect.left, LINK_RECT.left);
  assert.equal(result.calls?.update ?? context.calls.update, 1);
  assert.equal(context.calls.readArtifact, 1);
  assert.equal(context.calls.deleteArtifact, 0);
  assert.equal(result.link.sourcePage, SOURCE_PAGE);
  assert.equal(result.link.targetPage, TARGET_PAGE);
});

test('edit.links production normalizes omitted toPage and link rectangle defaults', async () => {
  const context = sourceBoundEditContext({
    serviceRequest: {
      sourcePage: SOURCE_PAGE,
      targetPage: SOURCE_PAGE,
      rect: LINK_RECT,
    },
  });
  const { context: handlerContext } = context;
  delete handlerContext.toPage;
  delete handlerContext.rect;
  const result = await handlers['edit.links'](handlerContext);
  assert.equal(result.link.sourcePage, SOURCE_PAGE);
  assert.equal(result.link.targetPage, SOURCE_PAGE);
  assert.equal(result.link.rect.left, LINK_RECT.left);
  assert.equal(result.link.rect.bottom, LINK_RECT.bottom);
  assert.equal(result.link.rect.right, LINK_RECT.right);
  assert.equal(result.link.rect.top, LINK_RECT.top);
  assert.equal(context.calls.update, 1);
});

test('edit.links production pre-service cancellation aborts before update', async () => {
  const controller = new AbortController();
  controller.abort(new Error('pre-cancel')); 
  const context = sourceBoundEditContext({ signal: controller.signal });
  await assert.rejects(handlers['edit.links'](context.context), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(context.calls.update, 0);
  assert.equal(context.calls.readArtifact, 0);
  assert.equal(context.calls.deleteArtifact, 0);
});

test('edit.links production post-service cancellation revokes retained artifact without reread', async () => {
  const controller = new AbortController();
  const context = sourceBoundEditContext({
    signal: controller.signal,
    serviceRequest: {
      sourcePage: SOURCE_PAGE,
      targetPage: TARGET_PAGE,
      rect: LINK_RECT,
      postCancelUpdate: true,
    },
  });
  context.context.incrementalGoToLink = {
    async update() {
      context.calls.update += 1;
      controller.abort(new Error('post-service cancel'));
      return {
        kind: 'pdf-incremental-goto-link',
        sourceDigest: context.sourceSha256,
        artifact: context.artifact,
        link: {
          sourcePage: SOURCE_PAGE,
          targetPage: TARGET_PAGE,
          rect: LINK_RECT,
        },
        evidence: {
          sourceDigestReverified: true,
          sourcePrefixPreserved: true,
          classicIncrementalRevisionAppended: true,
          pageCountMatched: true,
          pageTextMatched: true,
          pageBoxesMatched: true,
          pageValidationRendersMatched: true,
          outputUnsigned: true,
          artifactDigestBound: true,
          sourceUnchanged: true,
          localOnly: true,
        },
        limitations: INCREMENTAL_GOTO_LINK_LIMITATIONS,
      };
    },
  };
  await assert.rejects(handlers['edit.links'](context.context), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(context.calls.update, 1);
  assert.equal(context.calls.readArtifact, 0);
  assert.equal(context.calls.deleteArtifact, 1);
});

test('edit.links production mismatch reread triggers cleanup and aggregates revoke failure', async () => {
  const context = sourceBoundEditContext({
    readArtifact: () => Buffer.from('corrupt-artifact'),
    deleteFailure: true,
  });
  let error;
  try {
    await handlers['edit.links'](context.context);
    assert.fail('Expected edit.links boundary failure.');
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, 'EDIT_LINKS_CLEANUP_FAILED');
  assert.equal(context.calls.update, 1);
  assert.equal(context.calls.readArtifact, 1);
  assert.equal(context.calls.deleteArtifact, 1);
  assert.equal(error.cause instanceof AggregateError, true);
});
