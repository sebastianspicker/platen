import assert from 'node:assert/strict';
import test from 'node:test';
import { createRasterWorkflowController } from '../src/controllers/raster-workflow-controller.js';

function fixture() {
  const calls = [];
  const errors = [];
  const downloads = [];
  const jsonDownloads = [];
  const confirmations = [];
  const plan = {
    id: 'redaction-plan-1',
    type: 'redaction-plan',
    profile: 'source-bound-redaction-plan-v1',
    schemaVersion: 1,
    status: 'proposed-not-applied',
    createdAtLocal: '2026-07-19T10:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
    coordinateSpace: 'normalized-cropbox-top-left-v1',
    marks: [{ id: 'mark-1', page: 2, region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } }],
    applicationProfile: 'verified-raster-burn-v2',
    planSha256: 'b'.repeat(64),
  };
  const state = {
    analysis: { documentId: 'document-1', sha256: 'a'.repeat(64) },
    document: { name: 'source.pdf' },
    host: { redactionPlansReady: true, redactionPlanReportsReady: true, fullPageRedactionReady: true },
    selectedPage: 2,
    busyAction: null,
    error: null,
    cropRegion: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
    resizeWidth: '612',
    resizeHeight: '792',
    overlayText: 'Confidential',
    overlayPlacement: 'watermark',
    redactionText: 'secret phrase',
    redactionFullPage: false,
    redactionRegion: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
    redactionPlans: [],
    selectedRedactionPlanId: '',
    selectedRedactionMarkId: '',
    domainRevision: 3,
  };
  const operation = { documentId: 'document-1', controller: new AbortController() };
  const controller = createRasterWorkflowController({
    state,
    client: {
      async mutateRaster(documentId, name, parameters) {
        calls.push({ documentId, name, parameters: structuredClone(parameters) });
        return { id: 'artifact-1', displayName: `${name}.pdf` };
      },
      async runFullPageRedaction(documentId, sourceSha256, request, options) {
        calls.push({ documentId, name: 'full-page-redaction', sourceSha256, request: structuredClone(request), options });
        return {
          kind: 'pdf-full-page-redaction',
          artifact: { id: 'artifact-full-page', displayName: 'redacted-full-page.pdf' },
          redaction: { page: request.page, fullPage: true },
        };
      },
      async createRedactionPlan(documentId, request) {
        calls.push({ documentId, name: 'create-plan', request: structuredClone(request) });
        return { plan, revision: 4 };
      },
      async applyRedactionPlan(documentId, request) {
        calls.push({ documentId, name: 'apply-plan', request: structuredClone(request) });
        return {
          artifact: { id: 'artifact-plan', displayName: 'redacted-plan.pdf' },
          application: {
            status: 'artifact-created',
            planStatus: 'proposed-not-applied',
            textEvidence: 'validated-transiently-not-retained',
          },
        };
      },
      async exportRedactionPlanReport(documentId, request) {
        calls.push({ documentId, name: 'export-plan-report', request: structuredClone(request) });
        return {
          schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1',
          sourceSha256: request.sourceSha256, workspaceRevision: request.expectedWorkspaceRevision,
          planId: request.planId, planSha256: request.planSha256,
          planCreatedAtLocal: plan.createdAtLocal, coordinateSpace: plan.coordinateSpace,
          applicationProfile: plan.applicationProfile, marks: plan.marks,
          reportStatus: 'proposed-not-applied', pdfBytesChanged: false,
          reportSha256: 'd'.repeat(64),
        };
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error.message),
    finishOperation: () => { state.busyAction = null; },
    downloadDerivedArtifact: async (artifact) => downloads.push(artifact),
    triggerDownload: (download) => jsonDownloads.push(download),
    render: () => {},
    showError: (error) => errors.push(error.message),
    announce: () => {},
    confirm: (message) => { confirmations.push(message); return true; },
  });
  return { state, controller, calls, errors, downloads, jsonDownloads, confirmations, plan };
}

test('raster workflow owns bounded edit parameters', () => {
  const context = fixture();
  assert.deepEqual(context.controller.rasterParameters('crop'), {
    pages: [2],
    region: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
  });
  assert.deepEqual(context.controller.rasterParameters('resize'), {
    pages: [2], widthPoints: 612, heightPoints: 792,
  });
  assert.equal(context.controller.rasterParameters('overlay').overlay.pointSize, 36);
  context.state.resizeWidth = '12';
  assert.throws(() => context.controller.rasterParameters('resize'), /64 through 2048/u);
});

test('verified raster redaction clears sensitive text after synchronous request staging', async () => {
  const context = fixture();
  await context.controller.runRasterMutation('redact');
  assert.equal(context.state.redactionText, '');
  assert.equal(context.calls[0].parameters.redactions[0].removedText, 'secret phrase');
  assert.equal(context.calls[0].parameters.profile, 'verified-raster-burn-v2');
  assert.equal(context.downloads[0].displayName, 'redact.pdf');
  assert.deepEqual(context.errors, []);
});

test('verified raster redaction sends full-page targets when requested', async () => {
  const context = fixture();
  context.state.redactionFullPage = true;
  await context.controller.runRasterMutation('redact');
  assert.deepEqual(context.calls[0].parameters.redactions, [{ page: 2, fullPage: true, removedText: 'secret phrase' }]);
  assert.equal('region' in context.calls[0].parameters.redactions[0], false);
  assert.equal(context.state.redactionText, '');
});

test('object-level full-page redaction uses the selected page and stores its validated result', async () => {
  const context = fixture();
  await context.controller.runFullPageRedaction();
  assert.equal(context.calls[0].name, 'full-page-redaction');
  assert.equal(context.calls[0].documentId, 'document-1');
  assert.equal(context.calls[0].sourceSha256, 'a'.repeat(64));
  assert.deepEqual(context.calls[0].request, { page: 2 });
  assert(context.calls[0].options.signal instanceof AbortSignal);
  assert.equal(context.state.fullPageRedactionResult.kind, 'pdf-full-page-redaction');
  assert.equal(context.downloads[0].id, 'artifact-full-page');
  assert.match(context.confirmations[0], /object level/i);
});

test('source-bound redaction proposals select without applying and send no geometry or text on apply', async () => {
  const context = fixture();
  context.controller.syncRedactionPlans({
    namespaces: {
      redactions: [
        { id: 'legacy', type: 'redaction-plan', status: 'proposed-not-applied', marks: [] },
        context.plan,
      ],
    },
  });
  assert.equal(context.state.selectedRedactionPlanId, 'redaction-plan-1');
  assert.equal(context.state.selectedRedactionMarkId, 'mark-1');
  assert.equal(context.calls.length, 0);

  await context.controller.applyRedactionPlan();
  const request = context.calls[0].request;
  assert.deepEqual(request, {
    sourceSha256: 'a'.repeat(64),
    expectedWorkspaceRevision: 3,
    planId: 'redaction-plan-1',
    planSha256: 'b'.repeat(64),
    markIds: ['mark-1'],
  });
  assert.equal('removedText' in request, false);
  assert.equal('region' in request, false);
  assert.equal(context.downloads[0].id, 'artifact-plan');
  assert.match(context.confirmations[0], /separate image-only PDF/u);
  assert.equal(context.plan.status, 'proposed-not-applied');
});

test('creating a source-bound proposal uses current geometry without retaining exact text', async () => {
  const context = fixture();
  context.state.redactionText = 'must never enter the plan request';
  await context.controller.createRedactionPlan();
  const request = context.calls[0].request;
  assert.deepEqual(request.targets, [{
    page: 2,
    region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
  }]);
  assert.equal(JSON.stringify(request).includes('must never'), false);
  assert.equal(context.state.domainRevision, 4);
  assert.equal(context.state.selectedRedactionPlanId, 'redaction-plan-1');
  assert.match(context.confirmations[0], /No PDF bytes will change/u);
});

test('creating a source-bound full-page proposal sends full-page target only', async () => {
  const context = fixture();
  context.state.redactionFullPage = true;
  await context.controller.createRedactionPlan();
  const request = context.calls[0].request;
  assert.deepEqual(request.targets, [{ page: 2, fullPage: true }]);
});

test('exporting a selected proposal report downloads JSON without applying or mutating the plan', async () => {
  const context = fixture();
  context.controller.syncRedactionPlans({ namespaces: { redactions: [context.plan] } });
  await context.controller.exportRedactionPlanReport();
  assert.deepEqual(context.calls[0].request, {
    sourceSha256: 'a'.repeat(64), expectedWorkspaceRevision: 3,
    planId: 'redaction-plan-1', planSha256: 'b'.repeat(64),
  });
  assert.equal(context.calls[0].name, 'export-plan-report');
  assert.equal(context.jsonDownloads.length, 1);
  assert.equal(context.jsonDownloads[0].fileName, 'source-redaction-proposal-report.json');
  assert.equal(context.jsonDownloads[0].blob.type, 'application/json');
  assert.equal(context.downloads.length, 0);
  assert.equal(context.plan.status, 'proposed-not-applied');
});
