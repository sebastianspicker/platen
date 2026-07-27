import { normalizeAccessibilityAltText } from '../../core/accessibility-alt-text-contract.js';

export function createAccessibilityAltTextOperations({
  state, client, BlobConstructor, captureOperation, operationIsCurrent,
  reportOperationError, finishOperation, triggerDownload, render,
}) {
  async function createAccessibilityAltTextProposal() {
    const report = state.accessibilityReviewResult;
    const locator = state.accessibilityAltTextCandidateLocator;
    const authoredText = normalizeAccessibilityAltText(state.accessibilityAltText);
    const candidate = report?.remediationPlan?.candidates?.find((entry) => (
      entry?.action === 'author-image-alt-text'
        && entry.status === 'proposed-not-applied'
        && entry.target?.locator === locator
    ));
    if (!state.analysis.documentId || state.busyAction || !state.host?.accessibilityRemediationReady
      || report?.kind !== 'accessibility-review' || report.sourceDigest !== state.analysis.sha256
      || report.remediationPlan?.truncated !== false || !candidate || authoredText === null) return;
    const operation = captureOperation();
    const authoringStateIsCurrent = () => (
      state.accessibilityAltTextCandidateLocator === locator
      && normalizeAccessibilityAltText(state.accessibilityAltText) === authoredText
    );
    state.busyAction = 'Creating a source-bound image alt-text proposal…';
    state.error = null;
    state.accessibilityAltTextProposalResult = null;
    render();
    try {
      const created = await client.createAccessibilityProposal(operation.documentId, {
        sourceSha256: report.sourceDigest,
        reviewSha256: report.reportSha256,
        expectedWorkspaceRevision: state.domainRevision,
        operations: [{
          action: 'author-image-alt-text', target: { locator }, authoredText,
        }],
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.domainRevision = created.revision;
      if (!authoringStateIsCurrent()) return;
      const proposal = await client.exportAccessibilityProposal(
        operation.documentId, created.proposalId, { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation) || !authoringStateIsCurrent()) return;
      const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
      state.accessibilityAltTextProposalResult = {
        status: 'proposed-not-applied',
        page: candidate.target.page,
        imageNumber: candidate.target.imageNumber,
      };
      triggerDownload({
        blob: new BlobConstructor([proposal], {
          type: 'application/vnd.platen.accessibility-proposal+json;charset=utf-8',
        }),
        fileName: `${stem}-image-alt-text-proposal.json`,
        message: 'Source-bound image alt-text proposal exported. No PDF bytes or tags were changed.',
      });
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { createAccessibilityAltTextProposal };
}
