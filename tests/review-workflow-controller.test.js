import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewWorkflowController } from '../src/controllers/review-workflow-controller.js';

function fixture() {
  const calls = [];
  const downloads = [];
  const announcements = [];
  const errors = [];
  const state = {
    analysis: { documentId: 'document-1', sha256: 'a'.repeat(64) },
    document: { name: 'review.pdf' },
    selectedPage: 2,
    busyAction: null,
    error: null,
    prepressDpi: '144',
    preflightProfile: 'print-review',
    prepressResult: null,
    standardsProfile: 'pdfa-2u',
    standardsValidationResult: null,
    accessibilityReviewResult: null,
    accessibilityAltTextCandidateLocator: '',
    accessibilityAltText: '',
    accessibilityAltTextProposalResult: null,
    accessibilityDocumentLanguage: 'en-us',
    accessibilityDocumentTitle: 'Accessible review',
    incrementalAccessibilityMetadataResult: null,
    domainRevision: 4,
    host: {
      standardsValidationReady: true,
      accessibilityRemediationReady: true,
      incrementalAccessibilityMetadataReady: true,
    },
  };
  const client = {
    async runPrepress(documentId, operationName, options) {
      calls.push({ method: 'prepress', documentId, operationName, options });
      return operationName === 'preflight'
        ? { kind: 'preflight-review', status: 'review', profile: { id: 'print-review' } }
        : { kind: 'separation-preview', page: 2 };
    },
    async convertToCmyk(documentId, options) {
      calls.push({ method: 'cmyk', documentId, options });
      return { artifact: { id: 'artifact-cmyk', displayName: 'review-cmyk.pdf' } };
    },
    async createImposition() { throw new Error('not used'); },
    async runProductionValidation(documentId) {
      calls.push({ method: 'production', documentId });
      return { kind: 'production-validation', status: 'review' };
    },
    async assignOutputIntent(documentId, request, options) {
      calls.push({ method: 'output-intent', documentId, request, options });
      return {
        kind: 'output-intent-artifact',
        artifact: { id: 'artifact-output-intent', displayName: 'review-output-intent.pdf' },
      };
    },
    async runStandardsValidation(documentId, profile) {
      calls.push({ method: 'standards', documentId, profile });
      return { kind: 'standards-validation', status: 'compliant', standard: { profile } };
    },
    async runAccessibilityReview(documentId) {
      calls.push({ method: 'accessibility', documentId });
      return {
        kind: 'accessibility-review',
        status: 'review',
        sourceDigest: 'a'.repeat(64),
        reportSha256: 'b'.repeat(64),
        checks: [
          { id: 'document-language', status: 'warning' },
          { id: 'document-title', status: 'warning' },
        ],
        remediationPlan: {
          truncated: false,
          candidates: [
            { action: 'set-document-language', status: 'proposed-not-applied', target: null },
            { action: 'set-document-title', status: 'proposed-not-applied', target: null },
            {
              action: 'author-image-alt-text', status: 'proposed-not-applied',
              target: { page: 1, imageNumber: 0, locator: 'c'.repeat(64) },
            },
          ],
        },
      };
    },
    async runIncrementalAccessibilityMetadata(...args) {
      calls.push({ method: 'accessibility-metadata', args });
      return {
        kind: 'pdf-incremental-accessibility-metadata',
        artifact: { id: 'artifact-accessibility', displayName: 'review-language-title.pdf' },
      };
    },
    async createAccessibilityProposal(documentId, request) {
      calls.push({ method: 'proposal-create', documentId, request });
      return { proposalId: 'proposal-1', revision: 5 };
    },
    async exportAccessibilityProposal(documentId, proposalId) {
      calls.push({ method: 'proposal-export', documentId, proposalId });
      return '{"proposal":true}\n';
    },
  };
  const controller = createReviewWorkflowController({
    state,
    client,
    captureOperation: () => ({ documentId: 'document-1', controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error.message),
    finishOperation: () => { state.busyAction = null; },
    downloadDerivedArtifact: async (artifact, _operation, message) => {
      downloads.push({ artifact, message });
      return true;
    },
    downloadEphemeralDerivedArtifact: async (artifact) => {
      downloads.push({ artifact, ephemeral: true });
      return true;
    },
    triggerDownload: (download) => downloads.push(download),
    render: () => {},
    announce: (message) => announcements.push(message),
    showError: (error) => errors.push(error.message),
    confirm: () => true,
  });
  return { state, calls, downloads, announcements, errors, controller };
}

test('stale accessibility metadata results still enter one-shot artifact cleanup', async () => {
  const context = fixture();
  await context.controller.runAccessibilityReview();
  let cleanupCalled = false;
  const staleController = createReviewWorkflowController({
    state: context.state,
    client: {
      async runIncrementalAccessibilityMetadata() {
        return {
          kind: 'pdf-incremental-accessibility-metadata',
          artifact: { id: 'stale-artifact', displayName: 'stale.pdf' },
        };
      },
    },
    captureOperation: () => ({
      documentId: 'document-1',
      controller: new AbortController(),
    }),
    operationIsCurrent: () => false,
    reportOperationError: () => {},
    finishOperation: () => {},
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async (artifact) => {
      cleanupCalled = artifact.id === 'stale-artifact';
      return false;
    },
    triggerDownload: () => {},
    render: () => {},
    announce: () => {},
    showError: () => {},
    confirm: () => true,
  });
  await staleController.runIncrementalAccessibilityMetadata();
  assert.equal(cleanupCalled, true);
  assert.equal(context.state.incrementalAccessibilityMetadataResult, null);
});

test('review controller validates and runs prepress, standards, and accessibility workflows', async () => {
  const context = fixture();
  context.state.prepressDpi = '12.5';
  await context.controller.runPrepress('separations');
  assert.deepEqual(context.errors, ['Prepress DPI must be a whole number from 36 through 300.']);
  assert.deepEqual(context.calls, []);

  context.state.prepressDpi = '144';
  await context.controller.runPrepress('preflight');
  assert.equal(context.state.prepressResult.kind, 'preflight-review');
  assert.match(context.announcements.at(-1), /status review/u);
  context.controller.exportPreflightReport();

  await context.controller.runPrepressArtifact('icc-convert');
  assert.equal(context.downloads.some(({ artifact }) => artifact?.id === 'artifact-cmyk'), true);
  await context.controller.runProductionValidation();
  assert.equal(context.state.prepressResult.kind, 'production-validation');
  await context.controller.assignOutputIntent();
  const outputIntentCall = context.calls.find(({ method }) => method === 'output-intent');
  assert.deepEqual(outputIntentCall.request, {
    profile: 'local-ghostscript-default-cmyk-output-intent-v1',
    sourceSha256: 'a'.repeat(64),
  });
  assert(outputIntentCall.options.signal instanceof AbortSignal);
  assert.equal(context.state.prepressResult.kind, 'output-intent-artifact');
  assert.equal(context.downloads.at(-1).artifact.id, 'artifact-output-intent');
  assert.match(context.downloads.at(-1).message, /separate derived PDF/u);
  assert.match(context.downloads.at(-1).message, /does not establish PDF\/X conformance/u);

  await context.controller.runStandardsValidation();
  assert.equal(context.state.standardsValidationResult.status, 'compliant');
  context.controller.exportStandardsValidation();

  await context.controller.runAccessibilityReview();
  assert.equal(context.state.accessibilityReviewResult.kind, 'accessibility-review');
  context.controller.exportAccessibilityReview();
  await context.controller.createAccessibilityProposal();
  assert.equal(context.state.domainRevision, 5);
  assert.equal(context.calls.find(({ method }) => method === 'proposal-create').request.operations[0].action,
    'set-document-language');
  assert.equal(context.downloads.at(-1).fileName, 'review-accessibility-remediation-proposal.json');
  context.state.accessibilityAltTextCandidateLocator = 'c'.repeat(64);
  context.state.accessibilityAltText = '  Caf\u00e9 entrance  ';
  await context.controller.createAccessibilityAltTextProposal();
  const altTextCall = context.calls.filter(({ method }) => method === 'proposal-create').at(-1);
  assert.deepEqual(altTextCall.request.operations, [{
    action: 'author-image-alt-text',
    target: { locator: 'c'.repeat(64) },
    authoredText: 'Caf\u00e9 entrance',
  }]);
  assert.equal(context.state.domainRevision, 5);
  assert.equal(context.state.accessibilityAltTextProposalResult.status, 'proposed-not-applied');
  assert.equal(context.downloads.at(-1).fileName, 'review-image-alt-text-proposal.json');
  await context.controller.runIncrementalAccessibilityMetadata();
  const metadataCall = context.calls.find(({ method }) => method === 'accessibility-metadata');
  assert.deepEqual(metadataCall.args.slice(0, 3), [
    'document-1',
    'a'.repeat(64),
    { language: 'en-us', title: 'Accessible review' },
  ]);
  assert(metadataCall.args[3].signal instanceof AbortSignal);
  assert.equal(
    context.state.incrementalAccessibilityMetadataResult?.kind,
    'pdf-incremental-accessibility-metadata',
  );
  assert.equal(context.downloads.at(-1).artifact.id, 'artifact-accessibility');
  assert.equal(context.downloads.at(-1).ephemeral, true);
  assert.equal(context.errors.length, 1);
});
