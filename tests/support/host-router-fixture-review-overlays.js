import { HostError } from '../../scripts/host/host-error.mjs';

function createRedactionPlans() {
  return {
    calls: [],
    attempts: [],
    async createPlan(documentId, body, processing) {
      this.calls.push({ operation: 'create', documentId, body, processing });
      return { plan: { id: 'redaction-plan-1' }, revision: 1 };
    },
    async applyPlan(documentId, body, processing) {
      this.attempts.push({ documentId, body, processing });
      const keys = [
        'schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision',
        'planId', 'planSha256', 'markIds',
      ];
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== keys.length
        || !Object.keys(body).every((key) => keys.includes(key))) {
        throw new HostError(
          'INVALID_REDACTION_APPLICATION',
          'Redaction application request must use the exact versioned contract.',
          400,
        );
      }
      this.calls.push({ operation: 'apply', documentId, body, processing });
      return {
        artifact: { id: 'redaction-artifact-1' },
        application: { status: 'artifact-created' },
      };
    },
  };
}

function createRedactionPlanReports() {
  return {
    calls: [],
    async report(documentId, body, processing) {
      this.calls.push({ documentId, body, processing });
      return {
        schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1',
        sourceSha256: body.sourceSha256, workspaceRevision: body.expectedWorkspaceRevision,
        planId: body.planId, planSha256: body.planSha256,
        planCreatedAtLocal: '2026-07-19T00:00:00.000Z',
        coordinateSpace: 'normalized-cropbox-top-left-v1',
        applicationProfile: 'verified-raster-burn-v2',
        marks: [{ id: 'redaction-mark-1', page: 1, fullPage: true }],
        reportStatus: 'proposed-not-applied', pdfBytesChanged: false,
        reportSha256: 'b'.repeat(64),
      };
    },
  };
}

function createAccessibilityOverlays() {
  const accessibilityReviews = {
    review: async (_documentId, options) => ({
      kind: 'accessibility-review',
      profile: { id: 'basic-local-review', title: 'Basic local accessibility review', version: 3 },
      sourceDigest: 'a'.repeat(64), pageCount: 1, status: 'review-required',
      counts: { pass: 0, warning: 0, fail: 0, 'not-checked': 1 },
      checks: [{ id: 'pdf-ua-conformance', status: 'not-checked' }], options,
    }),
  };
  const accessibilityRemediations = {
    calls: [],
    async createProposal(documentId, body) {
      this.calls.push({ operation: 'create', documentId, body });
      return {
        proposalId: 'accessibility-proposal-1', revision: 1,
        status: 'proposed-not-applied', pdfWriterRequired: true, conformanceClaim: false,
      };
    },
    exportProposal(documentId, proposalId) {
      this.calls.push({ operation: 'export', documentId, proposalId });
      return '{"conformanceClaim":false,"id":"accessibility-proposal-1","status":"proposed-not-applied"}';
    },
  };
  return { accessibilityReviews, accessibilityRemediations };
}

export function createReviewOverlays() {
  const redactionPlans = createRedactionPlans();
  const redactionPlanReports = createRedactionPlanReports();
  const comparisons = {
    compareContent: async (documentId, secondaryDocumentId, options) => ({ kind: 'content', documentId, secondaryDocumentId, options }),
    comparePixels: async (documentId, secondaryDocumentId, options) => ({ kind: 'pixel', documentId, secondaryDocumentId, options }),
    compareCrossFormat: async (documentId, secondaryDocumentId, options) => ({ kind: 'cross-format', documentId, secondaryDocumentId, options }),
    describeOverlay: async (documentId, secondaryDocumentId, options) => ({ kind: 'overlay', documentId, secondaryDocumentId, options }),
    describeSideBySide: async (documentId, secondaryDocumentId, options) => ({ kind: 'side-by-side', documentId, secondaryDocumentId, options }),
    compareAnnotations: async (documentId, secondaryDocumentId, options) => ({ kind: 'annotations', documentId, secondaryDocumentId, options }),
    compareBatch: async (pairs, options) => ({ kind: 'batch', pairs, options }),
  };
  const prepress = {
    outputIntentProfileReady: true,
    outputIntentCalls: [],
    runPreflight: async (documentId, options) => ({ kind: 'preflight-review', documentId, options }),
    analyzeInkCoverage: async (documentId, options) => ({ kind: 'ink-coverage', documentId, options }),
    renderSeparations: async (documentId, options) => ({ kind: 'separations', documentId, options }),
    renderOverprintPreview: async (documentId, options) => ({ kind: 'overprint-preview', documentId, options }),
    convertToCmyk: async (documentId, options) => ({ kind: 'icc-cmyk-artifact', documentId, options, artifact: { id: 'cmyk-artifact', displayName: 'cmyk.pdf' } }),
    createImposition: async (documentId, options) => ({ kind: 'imposition-artifact', documentId, options, artifact: { id: 'imposition-artifact', displayName: 'imposed.pdf' } }),
    runProductionValidation: async (documentId, options) => ({ kind: 'print-production-validation', documentId, options, status: 'review-required' }),
    async assignOutputIntent(documentId, request, options) {
      this.outputIntentCalls.push({ documentId, request, options });
      return {
        kind: 'output-intent-artifact', documentId,
        artifact: { id: 'output-intent-artifact', displayName: 'output-intent.pdf' },
      };
    },
  };
  const accessibility = createAccessibilityOverlays();
  const standardsValidations = {
    calls: [],
    async validate(documentId, options) {
      this.calls.push({ documentId, options });
      return {
        kind: 'standards-validation', schemaVersion: 1,
        standard: {
          family: options.profile.startsWith('pdfa-') ? 'PDF/A' : 'PDF/UA',
          profile: options.profile,
        },
        sourceSha256: 'd'.repeat(64), status: 'compliant',
        authoritative: true, complete: true,
        counts: { passedRules: 10, failedRules: 0, passedChecks: 20, failedChecks: 0 },
        engine: { name: 'veraPDF', version: '1.30.1', bundleSha256: 'e'.repeat(64) },
        limitations: ['Named profile only.', 'Not legal certification.'],
      };
    },
  };
  return {
    redactionPlans, redactionPlanReports, comparisons, prepress,
    accessibilityReviews: accessibility.accessibilityReviews,
    accessibilityRemediations: accessibility.accessibilityRemediations,
    standardsValidations,
  };
}
