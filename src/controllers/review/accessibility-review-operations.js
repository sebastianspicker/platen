export function createAccessibilityReviewOperations({
  state,
  client,
  BlobConstructor,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
  announce,
  jsonDownload,
}) {
  async function runAccessibilityReview() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    state.busyAction = 'Running the fixed local accessibility review…';
    state.error = null;
    state.accessibilityReviewResult = null;
    state.accessibilityAltTextCandidateLocator = '';
    state.accessibilityAltText = '';
    state.accessibilityAltTextProposalResult = null;
    state.incrementalAccessibilityMetadataResult = null;
    render();
    try {
      const result = await client.runAccessibilityReview(operation.documentId, {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      state.accessibilityReviewResult = result;
      announce(`Local accessibility review completed with status ${result.status}; unresolved semantics still require human review.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  function exportAccessibilityReview() {
    if (state.accessibilityReviewResult?.kind !== 'accessibility-review') return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
    jsonDownload(
      state.accessibilityReviewResult,
      `${stem}-accessibility-review.json`,
      'Non-authoritative local accessibility review exported as JSON.',
    );
  }

  async function createAccessibilityProposal() {
    const report = state.accessibilityReviewResult;
    const candidates = Array.isArray(report?.remediationPlan?.candidates)
      ? report.remediationPlan.candidates.filter(({ action }) => action !== 'author-image-alt-text')
      : [];
    if (!state.analysis.documentId || state.busyAction || !state.host?.accessibilityRemediationReady
      || report?.kind !== 'accessibility-review' || report.sourceDigest !== state.analysis.sha256
      || report.remediationPlan?.truncated !== false || !candidates.length) return;
    const operation = captureOperation();
    state.busyAction = 'Creating a source-bound accessibility remediation proposal…';
    state.error = null;
    render();
    try {
      const operations = candidates.map((candidate) => ({
        action: candidate.action,
        target: candidate.target?.locator ? { locator: candidate.target.locator } : null,
      }));
      const created = await client.createAccessibilityProposal(operation.documentId, {
        sourceSha256: report.sourceDigest,
        reviewSha256: report.reportSha256,
        expectedWorkspaceRevision: state.domainRevision,
        operations,
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.domainRevision = created.revision;
      const proposal = await client.exportAccessibilityProposal(
        operation.documentId,
        created.proposalId,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
      triggerDownload({
        blob: new BlobConstructor([proposal], {
          type: 'application/vnd.platen.accessibility-proposal+json;charset=utf-8',
        }),
        fileName: `${stem}-accessibility-remediation-proposal.json`,
        message: 'Source-bound accessibility remediation proposal exported. No PDF bytes or tags were changed.',
      });
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { runAccessibilityReview, exportAccessibilityReview, createAccessibilityProposal };
}
