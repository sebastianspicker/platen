export const PROJECT_BUNDLE_MAX_BYTES = 600 * 1024;
export const PORTABLE_PROJECT_BUNDLE_MAX_BYTES = 20 + PROJECT_BUNDLE_MAX_BYTES + (512 * 1024 * 1024);

export function projectBundleSummary(state, workspace, kind) {
  const populatedNamespaces = Object.fromEntries(
    Object.entries(workspace?.namespaces ?? {})
      .filter(([, records]) => Array.isArray(records) && records.length)
      .map(([namespace, records]) => [namespace, records.length]),
  );
  return {
    kind,
    revision: workspace?.revision ?? state.domainRevision,
    populatedNamespaces,
    auditEntries: Array.isArray(workspace?.audit) ? workspace.audit.length : 0,
    sourcePdfSha256: state.analysis.sha256,
  };
}
