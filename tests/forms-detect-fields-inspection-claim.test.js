import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfKitInspectionService } from '../scripts/host/pdfkit-inspection-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);
const sourceBytes = Buffer.from('%PDF-1.7\nforms-detect-fields-fixture\n%%EOF\n');

const digest = (value) => createHash('sha256').update(value).digest('hex');

function box() {
  return { x: 0, y: 0, width: 612, height: 792 };
}

function widget(index) {
  return {
    fieldName: `field-${index}`,
    fieldType: 'text',
    controlKind: null,
    flags: 0,
    annotationIndex: index,
    fingerprint: createHash('sha256').update(`widget-${index}`).digest('hex'),
  };
}

function page(index, widgets, widgetsTruncated) {
  return {
    index,
    label: `Page ${index}`,
    rotation: 0,
    boxes: { media: box(), crop: box(), bleed: box(), trim: box(), art: box() },
    annotations: [],
    annotationsTruncated: false,
    widgets,
    widgetsTruncated,
    links: [],
    linksTruncated: false,
  };
}

function inspectionResult() {
  const pages = [page(1, Array.from({ length: 50 }, (_value, index) => widget(index)), true), page(2, [], false)];
  pages[0].annotations = [{ subtype: 'link', annotationIndex: 0, fingerprint: createHash('sha256').update('inert-link').digest('hex') }];
  pages[0].links = [{ annotationIndex: 0, rect: { x: 72, y: 700, width: 180, height: 30 }, kind: 'goTo', targetPage: 2, target: null, remotePage: null }];
  return {
    document: {
      pageCount: 2,
      encrypted: false,
      locked: false,
      permissions: {
        copying: true,
        printing: true,
        changes: false,
        commenting: false,
        formFieldEntry: true,
        assembly: false,
        contentAccessibility: true,
        status: 'owner',
      },
      supportedAnnotationTypes: ['text', 'link', 'freeText', 'line', 'square', 'circle', 'highlight', 'underline', 'strikeOut', 'ink', 'stamp', 'popup', 'widget', 'unknown'],
    },
    metadata: {
      title: null,
      author: null,
      subject: null,
      creator: null,
      producer: null,
      creationDate: null,
      modificationDate: null,
      keywords: null,
    },
    pages,
    pagesTruncated: false,
    outline: { items: [], truncated: false },
    pageLabels: { present: false, items: [{ page: 1, label: 'Page 1' }, { page: 2, label: 'Page 2' }], truncated: false },
    optionalContent: {
      present: false,
      groupCount: 0,
      groups: [],
      groupsTruncated: false,
      defaultConfigurationPresent: false,
    },
  };
}

function appFetch(app) {
  return async (path, options = {}) => {
    const response = await invoke(app, {
      method: options.method ?? 'GET',
      url: path,
      headers: {
        origin: 'http://127.0.0.1:4173',
        ...(options.headers?.['Content-Type'] ? { 'content-type': options.headers['Content-Type'] } : {}),
        ...(options.headers?.['X-Platen-Token'] ? { 'x-platen-token': options.headers['X-Platen-Token'] } : {}),
      },
      body: options.body,
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forms-detect-fields-claim-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]),
    displayName: 'source.pdf',
  });
  const observed = { request: null, workspacePath: null, requestPath: null, actionExecutions: 0 };
  let popplerPageCount = 2;
  const adapter = {
    inspect: async ({ workspacePath, requestPath }) => {
      observed.workspacePath = workspacePath;
      observed.requestPath = requestPath;
      observed.request = JSON.parse(await readFile(requestPath, 'utf8'));
      return inspectionResult();
    },
    executeAction: () => {
      observed.actionExecutions += 1;
      throw new Error('inspection must never execute PDF actions');
    },
  };
  const service = new PdfKitInspectionService({
    store,
    pdfService: { inspect: async () => ({ pageCount: popplerPageCount }) },
    adapter,
  });
  const app = createAppHandler({
    staticHandler: () => {},
    store,
    service: { availability: async () => [] },
    workspaceState: {},
    pdfkitInspections: service,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  return {
    root, store, document, app, service, adapter, observed,
    setPopplerPageCount: (value) => { popplerPageCount = value; },
  };
}

test('forms.detect-fields claim uses the authenticated PDFKit inspection inventory without exposing values or executing actions', async (t) => {
  const state = await fixture(t);
  const sourceDigest = digest(sourceBytes);
  assert.equal(state.document.sha256, sourceDigest);

  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const signal = new AbortController().signal;
  const result = await client.runPdfKitInspection(state.document.id, { signal });

  assert.equal(result.kind, 'pdfkit-structure-inspection');
  assert.equal(result.sourceDigest, sourceDigest);
  assert.equal(result.evidence.sourceDigestReverified, true);
  assert.equal(result.evidence.privateInputsUnchanged, true);
  assert.equal(result.evidence.activeActionsNotExecuted, true);
  assert.equal(state.observed.actionExecutions, 0);
  const [firstPage, secondPage] = result.pages;
  assert.deepEqual(firstPage.links[0], {
    annotationIndex: 0,
    rect: { x: 72, y: 700, width: 180, height: 30 },
    kind: 'goTo',
    targetPage: 2,
    target: null,
    remotePage: null,
  });
  assert.equal(state.observed.request.limits.maxWidgetsPerPage, 50);
  assert.equal(state.observed.request.limits.maxPages, 100);

  assert.equal(firstPage.widgets.length, 50);
  assert.equal(firstPage.widgetsTruncated, true);
  assert.equal(secondPage.widgets.length, 0);
  assert.equal(secondPage.widgetsTruncated, false);
  assert(firstPage.widgets.every((entry) => Object.keys(entry).sort().join(',') === 'annotationIndex,controlKind,fieldName,fieldType,fingerprint,flags'));
  assert.equal('value' in firstPage.widgets[0], false);
  assert.equal('privateValue' in firstPage.widgets[0], false);
  assert.doesNotMatch(JSON.stringify(result), /private-widget-value|input\.pdf|request\.json|workspacePath|filePath/u);
  assert.equal(digest(await readFile(state.store.getSourcePath(state.document.id))), sourceDigest);
  assert.equal(state.observed.actionExecutions, 0);
});

test('forms.detect-fields claim rejects forged helper page counts, stale source bindings, and missing optional service', async (t) => {
  const state = await fixture(t);
  const url = `/api/documents/${state.document.id}/pdfkit-inspection`;
  const headers = {
    origin: 'http://127.0.0.1:4173',
    'x-platen-token': TOKEN,
    'content-type': 'application/json',
  };
  const unauthenticated = await invoke(state.app, {
    method: 'POST', url, headers: { origin: headers.origin, 'content-type': headers['content-type'] },
    body: JSON.stringify({ profile: 'macos-read-only-v1' }),
  });
  assert.equal(unauthenticated.statusCode, 401);
  state.setPopplerPageCount(3);
  const forged = await invoke(state.app, {
    method: 'POST', url, headers, body: JSON.stringify({ profile: 'macos-read-only-v1' }),
  });
  assert.equal(forged.statusCode, 502);
  assert.equal(JSON.parse(forged.body).error.code, 'PDFKIT_PAGE_COUNT_MISMATCH');

  state.setPopplerPageCount(2);
  const forgedStore = {
    getDocument: (documentId) => ({ ...state.store.getDocument(documentId), sha256: 'f'.repeat(64) }),
    getSourcePath: state.store.getSourcePath.bind(state.store),
    verifySource: state.store.verifySource.bind(state.store),
    createJobWorkspace: state.store.createJobWorkspace.bind(state.store),
    cleanupJob: state.store.cleanupJob.bind(state.store),
  };
  const forgedBindingApp = createAppHandler({
    staticHandler: () => {},
    store: state.store,
    service: { availability: async () => [] },
    workspaceState: {},
    pdfkitInspections: new PdfKitInspectionService({
      store: forgedStore,
      pdfService: { inspect: async () => ({ pageCount: 2 }) },
      adapter: state.adapter,
    }),
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  const forgedBinding = await invoke(forgedBindingApp, {
    method: 'POST', url, headers, body: JSON.stringify({ profile: 'macos-read-only-v1' }),
  });
  assert.equal(forgedBinding.statusCode, 500);
  assert.equal(JSON.parse(forgedBinding.body).error.code, 'SOURCE_INTEGRITY_FAILED');

  await writeFile(state.store.getSourcePath(state.document.id), Buffer.concat([sourceBytes, Buffer.from('stale')]), { mode: 0o400 });
  const stale = await invoke(state.app, {
    method: 'POST', url, headers, body: JSON.stringify({ profile: 'macos-read-only-v1' }),
  });
  assert.equal(stale.statusCode, 500);
  assert.equal(JSON.parse(stale.body).error.code, 'SOURCE_INTEGRITY_FAILED');

  const unavailable = createAppHandler({
    staticHandler: () => {},
    store: state.store,
    service: { availability: async () => [] },
    workspaceState: {},
    pdfkitInspections: null,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  const missing = await invoke(unavailable, {
    method: 'POST', url, headers, body: JSON.stringify({ profile: 'macos-read-only-v1' }),
  });
  assert.equal(missing.statusCode, 503);
  assert.equal(JSON.parse(missing.body).error.code, 'PDFKIT_INSPECTION_UNAVAILABLE');
});
