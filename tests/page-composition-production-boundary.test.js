import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfCompositionExecutor } from '../scripts/host/pdf-composition-executor.mjs';
import { PdfOneDocumentComposition } from '../scripts/host/pdf-one-document-composition.mjs';
import { handleDocumentMutationRoute } from '../scripts/host/routes/document-service-route-mutations.mjs';

const PRIMARY_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_ID = '22222222-2222-4222-8222-222222222222';
const PRIMARY_SHA = 'a'.repeat(64);
const SECONDARY_SHA = 'b'.repeat(64);

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function positiveInteger(value, label, { minimum = 1, maximum = 1_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const error = new Error(`${label} is invalid.`); error.code = 'INVALID_PARAMETER'; error.status = 400; throw error;
  }
  return value;
}

function routeFixture({ operation, body, service = {}, storeOverrides = {}, aborted = false, url = null } = {}) {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  const controller = new AbortController();
  if (aborted) controller.abort();
  const documents = new Map([
    [PRIMARY_ID, { id: PRIMARY_ID, sha256: PRIMARY_SHA, size: 128, mediaType: 'application/pdf' }],
    [SECONDARY_ID, { id: SECONDARY_ID, sha256: SECONDARY_SHA, size: 128, mediaType: 'application/pdf' }],
  ]);
  const events = [];
  const store = {
    getDocument(id) { const document = documents.get(id); if (!document) throw Object.assign(new Error('missing'), { code: 'DOCUMENT_NOT_FOUND' }); return document; },
    async verifySource(id) { events.push(['verify', id]); return true; },
    async deleteArtifact(id) { events.push(['delete', id]); },
    ...storeOverrides,
  };
  const defaults = {
    async extractPages(_id, pages, options) { events.push(['extract', pages, options]); return { id: 'extract-artifact' }; },
    async arrangePages(_id, pages, options) { events.push(['arrange', pages, options]); return { id: 'arrange-artifact' }; },
    async duplicatePages(_id, pages, options) { events.push(['duplicate', pages, options]); return { id: 'duplicate-artifact' }; },
    async splitDocument(_id, options) { events.push(['split', options]); return [{ id: 'split-1' }, { id: 'split-2' }]; },
    async splitByPageCount(_id, pagesPerOutput, options) { events.push(['split-rule', pagesPerOutput, options]); return [{ id: 'split-rule-1' }]; },
    async reversePages(_id, options) { events.push(['reverse', options]); return { id: 'reverse-artifact' }; },
    async mergeDocuments(_primary, secondary, options) { events.push(['merge', secondary, options]); return { id: 'merge-artifact' }; },
    async interleaveDocuments(_primary, secondary, options) { events.push(['interleave', secondary, options]); return { id: 'interleave-artifact' }; },
    async insertDocument(_primary, secondary, afterPage, options) { events.push(['insert', secondary, afterPage, options]); return { id: 'insert-artifact' }; },
    async replacePages(_primary, secondary, startPage, endPage, options) { events.push(['replace', secondary, startPage, endPage, options]); return { id: 'replace-artifact' }; },
    async inspect() { return { pageCount: 3 }; },
    ...service,
  };
  const context = {
    operation,
    request: { method: 'POST' },
    response,
    url: new URL(url ?? `http://127.0.0.1/api/documents/${PRIMARY_ID}/${operation}`),
    documentId: PRIMARY_ID,
    processing: { signal: controller.signal },
    service: defaults,
    store,
    exactJsonObject,
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => structuredClone(body),
    json: (_response, status, value) => { response.status = status; response.body = value; },
    parsePositiveInteger: positiveInteger,
  };
  return { context, controller, events, response, store };
}

test('composition routes require exact query-free source-bound bodies for every operation family', async () => {
  const oneSource = { sourceSha256: PRIMARY_SHA };
  const twoSource = {
    primarySourceSha256: PRIMARY_SHA,
    secondaryDocumentId: SECONDARY_ID,
    secondarySourceSha256: SECONDARY_SHA,
  };
  const cases = [
    ['extract', { ...oneSource, pages: [1] }, 'extract'],
    ['arrange', { ...oneSource, pages: [2, 1] }, 'arrange'],
    ['delete', { ...oneSource, pages: [2] }, 'arrange'],
    ['duplicate', { ...oneSource, pages: [1] }, 'duplicate'],
    ['split', oneSource, 'split'],
    ['split-rule', { ...oneSource, pagesPerOutput: 2 }, 'split-rule'],
    ['reverse', oneSource, 'reverse'],
    ['merge', twoSource, 'merge'],
    ['interleave', twoSource, 'interleave'],
    ['insert', { ...twoSource, afterPage: 0 }, 'insert'],
    ['replace', { ...twoSource, startPage: 1, endPage: 2 }, 'replace'],
  ];
  for (const [operation, body, expectedEvent] of cases) {
    const fixture = routeFixture({ operation, body });
    assert.equal(await handleDocumentMutationRoute(fixture.context), true, operation);
    assert.equal(fixture.response.status, 201, operation);
    assert.equal(fixture.events.some(([name]) => name === expectedEvent), true, operation);
    assert.equal(fixture.events.filter(([name]) => name === 'verify').length >= (body.secondaryDocumentId ? 4 : 2), true, operation);
    fixture.response.emit('finish');
  }
});

test('composition routes reject unknown, missing, queried, and stale source bindings before service work', async () => {
  const base = { sourceSha256: PRIMARY_SHA, pages: [1] };
  for (const body of [{ pages: [1] }, { ...base, unknown: true }]) {
    const fixture = routeFixture({ operation: 'extract', body });
    await assert.rejects(handleDocumentMutationRoute(fixture.context), { code: 'INVALID_COMPOSITION_REQUEST', status: 400 });
    assert.equal(fixture.events.some(([name]) => name === 'extract'), false);
  }
  const stale = routeFixture({ operation: 'extract', body: { ...base, sourceSha256: '0'.repeat(64) } });
  await assert.rejects(handleDocumentMutationRoute(stale.context), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  assert.equal(stale.events.some(([name]) => name === 'extract'), false);
  const queried = routeFixture({
    operation: 'extract', body: base,
    url: `http://127.0.0.1/api/documents/${PRIMARY_ID}/extract?unsafe=1`,
  });
  await assert.rejects(handleDocumentMutationRoute(queried.context), { code: 'INVALID_PARAMETER', status: 400 });
});

test('composition routes revoke post-service cancellation and disconnected artifacts', async () => {
  const cancelled = routeFixture({
    operation: 'extract', body: { sourceSha256: PRIMARY_SHA, pages: [1] },
    service: {
      async extractPages() { cancelled.controller.abort(); return { id: 'cancelled-artifact' }; },
    },
  });
  await assert.rejects(handleDocumentMutationRoute(cancelled.context), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(cancelled.events.some(([name, id]) => name === 'delete' && id === 'cancelled-artifact'), true);

  let resolveDeleted;
  const deleted = new Promise((resolve) => { resolveDeleted = resolve; });
  const disconnected = routeFixture({
    operation: 'merge',
    body: { primarySourceSha256: PRIMARY_SHA, secondaryDocumentId: SECONDARY_ID, secondarySourceSha256: SECONDARY_SHA },
    storeOverrides: { async deleteArtifact(id) { disconnected.events.push(['delete', id]); resolveDeleted(id); } },
  });
  assert.equal(await handleDocumentMutationRoute(disconnected.context), true);
  disconnected.response.emit('close');
  assert.equal(await deleted, 'merge-artifact');
});

test('composition route surfaces artifact cleanup failure instead of reporting success', async () => {
  const fixture = routeFixture({
    operation: 'reverse', body: { sourceSha256: PRIMARY_SHA },
    storeOverrides: { async deleteArtifact() { throw new Error('delete failed'); } },
  });
  fixture.response.destroyed = true;
  await assert.rejects(handleDocumentMutationRoute(fixture.context), { code: 'COMPOSITION_ROUTE_CLEANUP_FAILED', status: 500 });
  assert.equal(fixture.response.status, undefined);
});

async function executorFixture(t, { cancelAfterPromotion = false, cleanupFailure = false, deleteFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'page-composition-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePaths = new Map([
    [PRIMARY_ID, join(root, 'primary.pdf')],
    [SECONDARY_ID, join(root, 'secondary.pdf')],
  ]);
  await Promise.all([...sourcePaths.values()].map((path) => writeFile(path, 'source')));
  const controller = new AbortController();
  const events = [];
  const outputPages = new Map();
  const store = {
    getDocument(id) { return { id, displayName: id === PRIMARY_ID ? 'primary.pdf' : 'secondary.pdf', sha256: id === PRIMARY_ID ? PRIMARY_SHA : SECONDARY_SHA }; },
    getSourcePath(id) { return sourcePaths.get(id); },
    async verifySource(id) { events.push(['verify', id]); },
    async createJobWorkspace() { return mkdtemp(join(root, 'job-')); },
    async cleanupJob(workspace) { events.push(['cleanup', workspace]); if (cleanupFailure) throw new Error('cleanup failed'); await rm(workspace, { recursive: true, force: true }); },
    async promotePdfArtifact(documentId, _path, options) {
      const artifact = { id: 'promoted-artifact', documentId, displayName: options.displayName, operation: options.operation };
      events.push(['promote', artifact.id]);
      if (cancelAfterPromotion) controller.abort();
      return artifact;
    },
    async deleteArtifact(id) { events.push(['delete', id]); if (deleteFailure) throw new Error('delete failed'); },
  };
  const adapter = {
    async execute(operation, parameters) {
      if (operation === 'splitPages') {
        const output = parameters.outputPattern.replace('%d', String(parameters.firstPage));
        outputPages.set(output, 1); await writeFile(output, 'page'); return { stdout: '' };
      }
      if (operation === 'mergeDocuments') {
        outputPages.set(parameters.output, parameters.inputs.reduce((sum, input) => sum + (outputPages.get(input) ?? 1), 0));
        await writeFile(parameters.output, 'merged'); return { stdout: '' };
      }
      throw new Error(`unexpected adapter operation ${operation}`);
    },
  };
  const validation = {
    async inspectSources(ids) { return new Map(ids.map((id) => [id, { pageCount: 1 }])); },
    validateSelections() {},
    async verifySources(ids) { await Promise.all(ids.map((id) => store.verifySource(id))); },
    async validateDerivedPdf(path, { expectedPageCount }) { return { pageCount: outputPages.get(path) ?? expectedPageCount }; },
    async semanticManifest(_path, pageCount) {
      return { pages: Array.from({ length: pageCount }, (_, index) => ({ proof: index + 1 })), sha256: 'c'.repeat(64) };
    },
    async validateCompositionManifest(_path, _expectedPages) { return { sha256: 'c'.repeat(64) }; },
    async digestOutput() { return 'c'.repeat(64); },
  };
  return { executor: new PdfCompositionExecutor({ store, adapter, validation }), controller, events };
}

test('executor revokes promotion after post-promotion cancellation', async (t) => {
  const fixture = await executorFixture(t, { cancelAfterPromotion: true });
  await assert.rejects(fixture.executor.composePages(PRIMARY_ID, [{ documentId: PRIMARY_ID, page: 1 }], {
    signal: fixture.controller.signal,
  }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(fixture.events.filter(([name]) => ['promote', 'delete'].includes(name)).map(([name]) => name), ['promote', 'delete']);
});

test('executor revokes a merge promotion and surfaces workspace cleanup failure', async (t) => {
  const fixture = await executorFixture(t, { cleanupFailure: true });
  await assert.rejects(fixture.executor.mergeDocuments(PRIMARY_ID, SECONDARY_ID), { code: 'COMPOSITION_CLEANUP_FAILED', status: 500 });
  assert.deepEqual(fixture.events.filter(([name]) => ['promote', 'cleanup', 'delete'].includes(name)).map(([name]) => name), ['promote', 'cleanup', 'delete']);
});

test('split rolls back every earlier artifact when a later output fails or cancellation follows promotion', async () => {
  for (const mode of ['failure', 'cancel']) {
    const controller = new AbortController();
    const deleted = [];
    let calls = 0;
    const executor = {
      async composePages() {
        calls += 1;
        if (calls === 1) {
          if (mode === 'cancel') controller.abort();
          return { id: `${mode}-first` };
        }
        throw new Error('later output failed');
      },
      async deleteArtifact(id) { deleted.push(id); },
    };
    const composition = new PdfOneDocumentComposition({ inspection: { async inspect() { return { pageCount: 3 }; } }, executor });
    await assert.rejects(composition.splitDocument(PRIMARY_ID, { signal: controller.signal }),
      (error) => mode === 'cancel' ? error?.code === 'JOB_CANCELLED' : error?.message === 'later output failed');
    assert.deepEqual(deleted, [`${mode}-first`]);
  }
});

test('split fails closed when atomic rollback cannot revoke an earlier output', async () => {
  let calls = 0;
  const executor = {
    async composePages() { calls += 1; if (calls === 1) return { id: 'first' }; throw new Error('later failed'); },
    async deleteArtifact() { throw new Error('rollback failed'); },
  };
  const composition = new PdfOneDocumentComposition({ inspection: { async inspect() { return { pageCount: 2 }; } }, executor });
  await assert.rejects(composition.splitDocument(PRIMARY_ID), { code: 'SPLIT_ROLLBACK_FAILED', status: 500 });
});
