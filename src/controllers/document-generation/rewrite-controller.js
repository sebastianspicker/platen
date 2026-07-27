const BUSY_LABELS = Object.freeze({
  optimize: 'Compressing a derived PDF…',
  rewrite: 'Repair-rewriting a derived PDF…',
  'flatten-transparency': 'Flattening transparency in a derived PDF…',
});

async function runRewriteLocalDocument(context, mode) {
  const {
    state,
    client,
    removeHostDocument,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    triggerDownload,
    render,
  } = context;
  if (!state.analysis.documentId || state.busyAction) return;
  const operation = captureOperation();
  state.busyAction = BUSY_LABELS[mode] ?? 'Rewriting a derived PDF…';
  state.error = null;
  render();
  let hosted = null;
  try {
    hosted = await client.rewriteDocument(operation.documentId, mode, {
      signal: operation.controller.signal,
    });
    const blob = await client.documentSource(hosted.id, {
      signal: operation.controller.signal,
    });
    if (!operationIsCurrent(operation)) return;
    triggerDownload({
      blob,
      fileName: hosted.displayName,
      message: `${hosted.displayName} created locally. The source PDF is unchanged.`,
    });
  } catch (error) {
    reportOperationError(error, operation);
  } finally {
    if (hosted?.id) {
      await removeHostDocument(hosted.id);
    }
    finishOperation(operation);
  }
}

export function createDocumentRewriteController(options) {
  const context = { ...options };
  async function rewriteLocalDocument(mode) {
    return runRewriteLocalDocument(context, mode);
  }
  return Object.freeze({ rewriteLocalDocument });
}
