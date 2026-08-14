import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAppHandler } from '../scripts/host/router.mjs';
import { ComparisonService } from '../scripts/host/comparison-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { encodeRgbaPng, decodePng } from '../scripts/host/raster-png-codec.mjs';
import { createComparisonEndpoints } from '../src/core/local-host-comparison-endpoints.js';
import { createComparisonWorkflowController } from '../src/controllers/comparison-workflow-controller.js';
import { makeTextPdf } from './pdf-fixture.js';
import { invoke } from './support/host-router-fixture-base.js';

const HASH = /^[a-f0-9]{64}$/u;
const headers = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'comparison-claims-token',
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pngFor(kind) {
  return encodeRgbaPng({
    width: 2,
    height: 1,
    pixels: Buffer.from(kind === 'primary'
      ? [0, 0, 0, 255, 20, 20, 20, 255]
      : [0, 0, 0, 255, 220, 20, 20, 255]),
  });
}

async function harness({ workspace = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r07-comparison-'));
  const store = await new DocumentStore({ root }).initialize();
  const primary = await store.createDocument({
    stream: Readable.from([makeTextPdf('PRIMARY SOURCE')]), displayName: 'primary.pdf',
  });
  const secondary = await store.createDocument({
    stream: Readable.from([makeTextPdf('SECONDARY SOURCE')]), displayName: 'secondary.pdf',
  });
  const calls = { inspect: [], extract: [], render: [], verify: [] };
  const pdfService = {
    async inspect(id) { calls.inspect.push(id); return { pageCount: 1 }; },
    async extractText(id) {
      calls.extract.push(id);
      return [{ page: 1, text: id === primary.id ? 'before value' : 'after value' }];
    },
    async renderThumbnail(id, options) {
      calls.render.push({ id, options });
      return pngFor(id === primary.id ? 'primary' : 'secondary');
    },
    async renderOverlayPageExactDpi(id, options) {
      calls.render.push({ id, options, exact: true });
      return pngFor(id === primary.id ? 'primary' : 'secondary');
    },
  };
  const originalVerify = store.verifySource.bind(store);
  store.verifySource = async (id) => {
    calls.verify.push(id);
    return originalVerify(id);
  };
  const workspaceState = workspace ? new WorkspaceStateStore(store) : null;
  const comparison = new ComparisonService({ store, pdfService, workspaceState });
  return {
    root, store, primary, secondary, comparison, workspaceState, calls,
    async dispose() { await store.dispose(); },
  };
}

function assertExactPair(report, primary, secondary) {
  assert.equal(report.inputs.length, 2);
  assert.notEqual(report.inputs[0].documentId, report.inputs[1].documentId);
  assert.deepEqual(report.inputs, [
    { documentId: primary.id, sha256: primary.sha256, role: 'primary' },
    { documentId: secondary.id, sha256: secondary.sha256, role: 'secondary' },
  ]);
  for (const input of report.inputs) assert.match(input.sha256, HASH);
}

test('compare.pixel is a decoded, bounded, source-digest-bound raster report', async () => {
  const value = await harness();
  try {
    const before = { primary: value.primary.sha256, secondary: value.secondary.sha256 };
    const report = await value.comparison.comparePixels(
      value.primary.id, value.secondary.id, { pages: [1], dpi: 96 },
    );
    assert.equal(report.kind, 'pixel');
    assert.equal(report.dpi, 96);
    assertExactPair(report, value.primary, value.secondary);
    assert.deepEqual(report.stats, { comparedPages: 1, changedPixels: 1, comparedPixels: 2 });
    const page = report.pages[0];
    assert.equal(page.status, 'compared');
    assert.equal(page.changedPixels, 1);
    assert.equal(page.comparedPixels, 2);
    assert.equal(page.differenceImage.format, 'image/png');
    const difference = Buffer.from(page.differenceImage.data, 'base64');
    assert.equal(page.differenceImage.sha256, digest(difference));
    assert.deepEqual(decodePng(difference).pixels, Buffer.from([0, 0, 0, 255, 255, 0, 0, 255]));
    assert.equal('alignment' in page, false);
    assert.equal('threshold' in page, false);
    assert.equal('artifact' in report, false);
    assert.deepEqual(
      { primary: value.store.getDocument(value.primary.id).sha256, secondary: value.store.getDocument(value.secondary.id).sha256 },
      before,
    );
    assert.equal(value.calls.render.length, 2);
    assert.equal(value.calls.verify.filter((id) => id === value.primary.id).length, 2);
    assert.equal(value.calls.verify.filter((id) => id === value.secondary.id).length, 2);
  } finally {
    await value.dispose();
  }
});

test('compare.annotations compares only workspace annotation snapshots, never embedded PDF annotations', async () => {
  const value = await harness({ workspace: true });
  try {
    value.workspaceState.createEntity(value.primary.id, 'annotations', {
      id: 'same', text: 'old', sourcePdfAnnotation: 'embedded-marker-not-parsed',
    });
    value.workspaceState.createEntity(value.primary.id, 'annotations', { id: 'deleted', text: 'gone' });
    value.workspaceState.createEntity(value.secondary.id, 'annotations', {
      id: 'same', text: 'new', sourcePdfAnnotation: 'embedded-marker-not-parsed',
    });
    value.workspaceState.createEntity(value.secondary.id, 'annotations', { id: 'added', text: 'new note' });
    const report = await value.comparison.compareAnnotations(value.primary.id, value.secondary.id);
    assert.equal(report.kind, 'annotations');
    assertExactPair(report, value.primary, value.secondary);
    assert.deepEqual(report.stats, { added: 1, deleted: 1, changed: 1, unchanged: 0 });
    assert.deepEqual(report.added.map(({ id }) => id), ['added']);
    assert.deepEqual(report.deleted.map(({ id }) => id), ['deleted']);
    assert.equal(report.changed[0].id, 'same');
    assert.equal(value.calls.inspect.length, 0);
    assert.equal(value.calls.extract.length, 0);
    assert.equal(value.calls.render.length, 0);
    assert.equal('pdf' in report, false);
    assert.equal(value.calls.verify.filter((id) => id === value.primary.id).length, 2);
    assert.equal(value.calls.verify.filter((id) => id === value.secondary.id).length, 2);
  } finally {
    await value.dispose();
  }
});

test('compare.batch accepts one through eight sequential source-bound pairs and rejects ninth, cross-format, and cancellation claims', async () => {
  const value = await harness();
  try {
    const pairs = Array.from({ length: 8 }, () => ({
      primaryDocumentId: value.primary.id,
      secondaryDocumentId: value.secondary.id,
    }));
    const report = await value.comparison.compareBatch(pairs, { mode: 'content' });
    assert.equal(report.kind, 'batch');
    assert.equal(report.mode, 'content');
    assert.equal(report.reports.length, 8);
    for (const nested of report.reports) assertExactPair(nested, value.primary, value.secondary);
    assert.equal(value.calls.verify.filter((id) => id === value.primary.id).length, 16);
    assert.equal(value.calls.verify.filter((id) => id === value.secondary.id).length, 16);
    await assert.rejects(
      value.comparison.compareBatch([...pairs, pairs[0]], { mode: 'content' }),
      (error) => error.code === 'BATCH_LIMIT' && error.status === 422,
    );
    await assert.rejects(
      value.comparison.compareBatch(pairs.slice(0, 1), { mode: 'cross-format' }),
      (error) => error.code === 'UNSUPPORTED_COMPARISON_MODE' && error.status === 400,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      value.comparison.compareBatch(pairs.slice(0, 1), { mode: 'pixel', signal: controller.signal }),
      (error) => error.code === 'JOB_CANCELLED' && error.status === 499,
    );
  } finally {
    await value.dispose();
  }
});

test('authenticated comparison route and local client preserve production pair bindings through the workflow controller', async () => {
  const value = await harness();
  try {
    const handler = createAppHandler({
      staticHandler: (_request, response) => response.end('static'),
      store: value.store,
      service: {},
      workspaceState: value.workspaceState ?? new WorkspaceStateStore(value.store),
      comparisons: value.comparison,
      token: headers['x-platen-token'],
      host: '127.0.0.1',
      port: 4173,
    });
    const unauthenticated = await invoke(handler, {
      method: 'POST',
      url: `/api/documents/${value.primary.id}/compare`,
      headers: { origin: headers.origin, 'content-type': headers['content-type'] },
      body: JSON.stringify({ secondaryDocumentId: value.secondary.id, mode: 'pixel', options: { pages: [1], dpi: 72 } }),
    });
    assert.equal(unauthenticated.statusCode, 401);
    const client = createComparisonEndpoints({
      json: async (path, options) => {
        const response = await invoke(handler, {
          method: options.method,
          url: path,
          headers,
          body: options.body,
        });
        const body = JSON.parse(response.body);
        if (response.statusCode >= 400) {
          const error = new Error(body.error?.message ?? 'comparison request failed');
          error.code = body.error?.code;
          error.status = response.statusCode;
          throw error;
        }
        return body;
      },
    });
    const direct = await client.compareDocuments(
      value.primary.id, value.secondary.id, 'pixel', { pages: [1], dpi: 72 },
    );
    assertExactPair(direct, value.primary, value.secondary);
    const verifiedBeforeOverlay = {
      primary: value.calls.verify.filter((id) => id === value.primary.id).length,
      secondary: value.calls.verify.filter((id) => id === value.secondary.id).length,
    };
    const overlay = await client.compareDocuments(
      value.primary.id, value.secondary.id, 'overlay', { page: 1, opacity: 0.5 },
    );
    assertExactPair(overlay, value.primary, value.secondary);
    assert.equal(overlay.dpi, 72);
    assert.equal(overlay.validation.sourceReread, true);
    assert.equal(overlay.image.size, Buffer.from(overlay.image.data, 'base64').length);
    assert.deepEqual(decodePng(Buffer.from(overlay.image.data, 'base64')).pixels, Buffer.from([127, 128, 128, 255, 167, 101, 101, 255]));
    assert.equal(value.calls.render.at(-1).options.dpi, 72);
    assert.equal(value.calls.verify.filter((id) => id === value.primary.id).length, verifiedBeforeOverlay.primary + 2);
    assert.equal(value.calls.verify.filter((id) => id === value.secondary.id).length, verifiedBeforeOverlay.secondary + 2);
    const verifiedBeforePanes = {
      primary: value.calls.verify.filter((id) => id === value.primary.id).length,
      secondary: value.calls.verify.filter((id) => id === value.secondary.id).length,
    };
    const sideBySide = await client.compareDocuments(
      value.primary.id, value.secondary.id, 'side-by-side', { page: 1 },
    );
    assertExactPair(sideBySide, value.primary, value.secondary);
    assert.equal(sideBySide.dpi, 72);
    assert.equal(sideBySide.semantics, 'primary-left-secondary-right');
    assert.deepEqual(sideBySide.panes.map(({ role }) => role), ['primary', 'secondary']);
    for (const pane of sideBySide.panes) {
      const bytes = Buffer.from(pane.data, 'base64');
      assert.equal(pane.mediaType, 'image/png');
      assert.equal(pane.encoding, 'base64');
      assert.equal(pane.size, bytes.length);
      assert.equal(pane.sha256, digest(bytes));
      assert.deepEqual({ width: pane.width, height: pane.height }, { width: 2, height: 1 });
    }
    assert.equal(sideBySide.validation.sourceReread, true);
    assert.equal(value.calls.verify.filter((id) => id === value.primary.id).length, verifiedBeforePanes.primary + 2);
    assert.equal(value.calls.verify.filter((id) => id === value.secondary.id).length, verifiedBeforePanes.secondary + 2);
    const state = {
      analysis: { documentId: value.primary.id },
      document: { name: 'primary.pdf' }, busyAction: false, comparisonMode: 'pixel',
      selectedPage: 1, comparisonReport: null, comparisonFileName: null, error: null,
    };
    const controller = createComparisonWorkflowController({
      state,
      client: {
        upload: async () => ({ id: value.secondary.id }),
        compareDocuments: (...args) => client.compareDocuments(...args),
      },
      captureOperation: () => ({ controller: new AbortController(), documentId: value.primary.id }),
      operationIsCurrent: () => true,
      reportOperationError: (error) => { throw error; },
      finishOperation: () => {},
      removeHostDocument: async () => {},
      triggerDownload: () => {},
      render: () => {},
      announce: () => {},
      document: null,
    });
    await controller.compareWithFile({ name: 'secondary.pdf' });
    assertExactPair(state.comparisonReport, value.primary, value.secondary);
    assert.equal(state.comparisonFileName, 'secondary.pdf');
  } finally {
    await value.dispose();
  }
});

test('comparison rejects unverified and drifted or forged source records before accepting a report', async () => {
  const primary = '11111111-1111-4111-8111-111111111111';
  const secondary = '22222222-2222-4222-8222-222222222222';
  const docs = new Map([
    [primary, { id: primary, sha256: 'a'.repeat(64), size: 1, mediaType: 'application/pdf' }],
    [secondary, { id: secondary, sha256: 'b'.repeat(64), size: 1, mediaType: 'application/pdf' }],
  ]);
  let verifyResult = false;
  const store = {
    getDocument(id) { const item = docs.get(id); if (!item) throw new Error('missing'); return { ...item }; },
    async verifySource() { return verifyResult; },
  };
  const pdfService = {
    async inspect() { return { pageCount: 1 }; },
    async extractText() { return [{ page: 1, text: 'content' }]; },
    async renderThumbnail() { return pngFor('primary'); },
  };
  const service = new ComparisonService({ store, pdfService });
  await assert.rejects(
    service.compareContent('forged-document-id', secondary),
    (error) => error.code === 'INVALID_ID' && error.status === 400,
  );
  await assert.rejects(
    service.compareContent(primary, secondary),
    (error) => error.code === 'SOURCE_INTEGRITY_FAILED' && error.status === 409,
  );
  verifyResult = true;
  const originalExtract = pdfService.extractText;
  pdfService.extractText = async (id) => {
    if (id === primary) docs.set(primary, { ...docs.get(primary), sha256: 'c'.repeat(64) });
    return originalExtract(id);
  };
  await assert.rejects(
    service.compareContent(primary, secondary),
    (error) => error.code === 'SOURCE_VERSION_MISMATCH' && error.status === 409,
  );
});
