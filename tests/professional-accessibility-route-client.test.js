import test from 'node:test';
import { PdfAccessibilityFormSemanticsService } from '../scripts/host/pdf-accessibility-form-semantics-service.mjs';
import { PdfAccessibilityLinksBookmarksService } from '../scripts/host/pdf-accessibility-links-bookmarks-service.mjs';
import { PdfAccessibilityTableSemanticsService } from '../scripts/host/pdf-accessibility-table-semantics-service.mjs';
import { accessibilityLinksBookmarks } from '../scripts/host/professional-capability/accessibility-ops-extra.mjs';
import { handleDocumentRoutes } from '../scripts/host/router-document-dispatch.mjs';
import { handleProfessionalAccessibilityRoute } from '../scripts/host/routes/professional-accessibility-routes.mjs';
import { createProfessionalAccessibilityEndpoints } from '../src/core/local-host-professional-accessibility-endpoints.js';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';
import { makeTablePdf, tableRequest } from './host-pdf-table-semantics-fixtures.mjs';
import { assert, addDocument, delivery, formRequest, initializedStore, routeContext } from './support/professional-accessibility-route-client-cli-support.js';

test('all three accessibility operations traverse route and strict client receipt validation', async (t) => {
  const store = await initializedStore(t, 'route-client');
  const linksDemo = await accessibilityLinksBookmarks({
    demoFixture: true,
    links: [{ text: 'Details', purpose: 'Read details', page: 3 }],
    bookmarks: [{ title: 'Summary', page: 2 }],
  });
  const scenarios = [
    {
      capabilityId: 'accessibility.form-semantics', operation: 'accessibility-form-semantics',
      endpoint: 'repairAccessibilityFormSemantics', sourcePdf: makeButtonWidgetPdf(),
      requestFor: formRequest,
    },
    {
      capabilityId: 'accessibility.table-semantics', operation: 'accessibility-table-semantics',
      endpoint: 'repairAccessibilityTableSemantics', sourcePdf: makeTablePdf(), requestFor: tableRequest,
    },
    {
      capabilityId: 'accessibility.links-bookmarks', operation: 'accessibility-links-bookmarks',
      endpoint: 'repairAccessibilityLinksBookmarks',
      sourcePdf: Buffer.from(linksDemo.pdf.subarray(0, linksDemo.sourceByteLength)),
      requestFor: () => linksDemo.repairRequest,
    },
  ];
  const professional = delivery(store, {
    accessibilityFormSemantics: new PdfAccessibilityFormSemanticsService({ store }),
    accessibilityTableSemantics: new PdfAccessibilityTableSemanticsService({ store }),
    accessibilityLinksBookmarks: new PdfAccessibilityLinksBookmarksService({ store }),
  });
  for (const scenario of scenarios) {
    const document = await addDocument(store, scenario.sourcePdf);
    const request = scenario.requestFor(scenario.sourcePdf);
    let delegated = null;
    const routed = routeContext({
      operation: scenario.operation,
      documentId: document.id,
      request,
      store,
      professionalCapabilities: {
        async deliverSourceBound(...args) {
          delegated = args;
          return professional.deliverSourceBound(...args);
        },
      },
    });
    assert.equal(await handleProfessionalAccessibilityRoute(routed.context), true);
    assert.equal(routed.response.status, 201);
    assert.equal(delegated[0], scenario.capabilityId);
    assert.equal(delegated[1], document.id);
    assert.deepEqual(delegated[2], request);
    assert.equal(delegated[3].signal instanceof AbortSignal, true);
    assert.equal(Object.hasOwn(routed.response.body.result, 'pdf'), false);
    let transport = null;
    const endpoints = createProfessionalAccessibilityEndpoints({
      json: async (path, options) => {
        transport = { path, options };
        return structuredClone(routed.response.body);
      },
    });
    const result = await endpoints[scenario.endpoint](document.id, request);
    assert.equal(transport.path, `/api/documents/${document.id}/${scenario.operation}`);
    assert.deepEqual(JSON.parse(transport.options.body), request);
    assert.equal(result.serviceReceipt.artifact.id, result.artifact.id);
    assert.equal(Object.isFrozen(result.serviceReceipt), true);
    const token = 'a'.repeat(64);
    const clientCalls = [];
    const client = new LocalHostClient({
      fetchImpl: async (path, options) => {
        clientCalls.push({ path, options });
        if (path === '/api/bootstrap') {
          return new Response(JSON.stringify({ sessionToken: token, engines: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(routed.response.body), { status: 201 });
      },
    });
    await client.bootstrap();
    const clientResult = await client[scenario.endpoint](document.id, request);
    assert.equal(clientResult.artifact.id, result.artifact.id);
    assert.equal(clientCalls[1].options.headers['X-Platen-Token'], token);
    const tampered = structuredClone(routed.response.body.result);
    tampered.serviceReceipt.artifact.sha256 = '0'.repeat(64);
    await assert.rejects(
      createProfessionalAccessibilityEndpoints({ json: async () => ({ result: tampered }) })[scenario.endpoint](document.id, request),
      { code: 'INVALID_LOCAL_HOST' },
    );
    const invalidRequest = structuredClone(request);
    if (scenario.capabilityId === 'accessibility.form-semantics') invalidRequest.fields[0].target.extra = true;
    if (scenario.capabilityId === 'accessibility.table-semantics') invalidRequest.table.cells[0].structRef.extra = true;
    if (scenario.capabilityId === 'accessibility.links-bookmarks') invalidRequest.links[0].locator.extra = true;
    assert.throws(() => endpoints[scenario.endpoint](document.id, invalidRequest), TypeError);
    routed.response.emit('finish');
    await store.deleteArtifact(result.artifact.id);
  }
});

test('table and links locator inventories are authenticated-route ready, digest-bound, and strictly validated by the client', async (t) => {
  const store = await initializedStore(t, 'locator-inventory');
  const linksDemo = await accessibilityLinksBookmarks({
    demoFixture: true, links: [{ text: 'Details', purpose: 'Read details', page: 3 }], bookmarks: [{ title: 'Summary', page: 2 }],
  });
  const scenarios = [
    { capabilityId: 'accessibility.table-semantics', operation: 'accessibility-table-semantics-inventory', endpoint: 'inspectAccessibilityTableSemanticsLocators', sourcePdf: makeTablePdf(), verify: (inventory) => assert.equal(inventory.table.cells.length, 4) },
    { capabilityId: 'accessibility.links-bookmarks', operation: 'accessibility-links-bookmarks-inventory', endpoint: 'inspectAccessibilityLinksBookmarksLocators', sourcePdf: Buffer.from(linksDemo.pdf.subarray(0, linksDemo.sourceByteLength)), verify: (inventory) => assert.equal(inventory.links.length + inventory.bookmarks.length, 2) },
  ];
  const professional = delivery(store, {});
  for (const scenario of scenarios) {
    const document = await addDocument(store, scenario.sourcePdf);
    const request = { sourceSha256: document.sha256 };
    let delegated = null;
    const routed = routeContext({
      operation: scenario.operation, documentId: document.id, request, store,
      professionalCapabilities: { async inventorySourceBound(...args) { delegated = args; return professional.inventorySourceBound(...args); } },
    });
    assert.equal(await handleProfessionalAccessibilityRoute(routed.context), true);
    assert.equal(routed.response.status, 200);
    assert.deepEqual(delegated.slice(0, 3), [scenario.capabilityId, document.id, request]);
    const transportCalls = [];
    const endpoints = createProfessionalAccessibilityEndpoints({
      json: async (path, options) => { transportCalls.push({ path, options }); return structuredClone(routed.response.body); },
    });
    const result = await endpoints[scenario.endpoint](document.id, document.sha256);
    assert.equal(transportCalls[0].path, `/api/documents/${document.id}/${scenario.operation}`);
    assert.deepEqual(JSON.parse(transportCalls[0].options.body), request);
    assert.equal(result.sourceSha256, document.sha256);
    assert.equal(Object.isFrozen(result.inventory), true);
    scenario.verify(result.inventory);
    const tampered = structuredClone(routed.response.body.result);
    tampered.sourceSha256 = '0'.repeat(64);
    await assert.rejects(
      createProfessionalAccessibilityEndpoints({ json: async () => ({ result: tampered }) })[scenario.endpoint](document.id, document.sha256),
      { code: 'INVALID_LOCAL_HOST' },
    );
    assert.throws(() => endpoints[scenario.endpoint](document.id, '0'.repeat(64), { extra: true }), TypeError);
  }
});

test('document dispatcher recognizes all professional accessibility routes', async () => {
  for (const operation of ['accessibility-form-semantics', 'accessibility-table-semantics', 'accessibility-links-bookmarks', 'accessibility-table-semantics-inventory', 'accessibility-links-bookmarks-inventory']) {
    let observed = null;
    const routes = new Proxy({
      professionalAccessibility: async (context) => { observed = context; return true; },
    }, { get(target, property) { return target[property] ?? (async () => false); } });
    assert.equal(await handleDocumentRoutes({
      pathname: `/api/documents/document-id/${operation}`,
      request: {}, response: {}, url: new URL(`http://127.0.0.1/api/documents/document-id/${operation}`),
      processing: { signal: new AbortController().signal }, store: {}, workspaceState: {}, routes,
      limits: new Proxy({ professionalAccessibility: 128 * 1024 }, { get: (target, property) => target[property] ?? 0 }),
      professionalCapabilities: { deliverSourceBound() {} },
    }), true);
    assert.equal(observed.documentId, 'document-id');
    assert.equal(observed.operation, operation);
    assert.equal(observed.professionalCapabilities.deliverSourceBound instanceof Function, true);
  }
});

test('route rejects extra fields and revokes a result when the response is already disconnected', async (t) => {
  const store = await initializedStore(t, 'route-failure');
  const sourcePdf = makeButtonWidgetPdf();
  const document = await addDocument(store, sourcePdf);
  const request = formRequest(sourcePdf);
  const professional = delivery(store, {
    accessibilityFormSemantics: new PdfAccessibilityFormSemanticsService({ store }),
  });
  const invalid = routeContext({ operation: 'accessibility-form-semantics', documentId: document.id, request: { ...request, extra: true }, professionalCapabilities: professional, store });
  await assert.rejects(handleProfessionalAccessibilityRoute(invalid.context), { code: 'PROFESSIONAL_ACCESSIBILITY_OPTIONS_INVALID', status: 400 });
  const retained = await professional.deliverSourceBound('accessibility.form-semantics', document.id, request);
  let artifactId = null;
  const disconnectedStore = {
    async deleteArtifact(id) { artifactId = id; return store.deleteArtifact(id); },
  };
  const disconnected = routeContext({
    operation: 'accessibility-form-semantics', documentId: document.id, request,
    professionalCapabilities: { async deliverSourceBound() { return retained; } },
    store: disconnectedStore, aborted: true,
  });
  assert.equal(await handleProfessionalAccessibilityRoute(disconnected.context), true);
  assert.equal(typeof artifactId, 'string');
  assert.throws(() => store.getArtifact(artifactId), { code: 'ARTIFACT_NOT_FOUND' });
});
