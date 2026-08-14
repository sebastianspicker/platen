import { validIncrementalAccessibilityMetadata } from '../../core/pdf-incremental-accessibility-metadata-contract.js';

const METADATA_ACTIONS = Object.freeze(['set-document-language', 'set-document-title']);
const METADATA_CHECKS = Object.freeze(['document-language', 'document-title']);

function sourceBoundMissingMetadataReport(report, sourceSha256) {
  if (report?.kind !== 'accessibility-review' || report.sourceDigest !== sourceSha256
    || report.remediationPlan?.truncated !== false) return false;
  const actions = new Set((report.remediationPlan?.candidates ?? [])
    .filter(({ status }) => status === 'proposed-not-applied')
    .map(({ action }) => action));
  const checks = new Map((report.checks ?? []).map((check) => [check.id, check.status]));
  return METADATA_ACTIONS.every((action) => actions.has(action))
    && METADATA_CHECKS.every((id) => checks.get(id) === 'warning');
}

export function createAccessibilityMetadataOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  downloadEphemeralDerivedArtifact,
  render,
  confirm,
}) {
  async function runIncrementalAccessibilityMetadata() {
    const sourceSha256 = state.analysis.sha256;
    const metadata = Object.freeze({
      language: String(state.accessibilityDocumentLanguage ?? ''),
      title: String(state.accessibilityDocumentTitle ?? ''),
    });
    if (!state.analysis.documentId || state.busyAction
      || state.host?.incrementalAccessibilityMetadataReady !== true
      || !sourceBoundMissingMetadataReport(state.accessibilityReviewResult, sourceSha256)
      || !validIncrementalAccessibilityMetadata(metadata)) return;
    if (!confirm('Create a separate append-only PDF with a document default language and Info title? Every source byte remains as the exact output prefix, so prior metadata remains recoverable. This does not add content-item language, tags, a structure tree, PDF/UA conformance, sanitization, or signature preservation.')) return;
    const operation = captureOperation();
    state.busyAction = 'Creating a verified document language and title copy…';
    state.error = null;
    state.incrementalAccessibilityMetadataResult = null;
    render();
    try {
      const result = await client.runIncrementalAccessibilityMetadata(
        operation.documentId,
        sourceSha256,
        metadata,
        { signal: operation.controller.signal },
      );
      const downloaded = await downloadEphemeralDerivedArtifact(
        result.artifact,
        operation,
        `${result.artifact.displayName} downloaded as a separate append-only PDF. The immutable source is unchanged; prior metadata remains recoverable in the output history.`,
      );
      if (downloaded && operationIsCurrent(operation)) {
        state.incrementalAccessibilityMetadataResult = result;
      }
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { runIncrementalAccessibilityMetadata };
}
