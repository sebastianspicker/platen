const MAX_ARRANGEABLE_PAGES = 500;

export function createArrangementOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  selectPage,
  setSelectedPageIdentity,
  render,
  announce,
  showError,
}) {
  function arrangementChanged() {
    const pageCount = state.analysis.inspection?.pageCount ?? 0;
    return state.pageOrder.length > 0
      && (state.pageOrder.length !== pageCount
        || state.pageOrder.some((page, index) => page !== index + 1));
  }

  function moveSelectedPage(offset) {
    const index = state.pageOrder.indexOf(state.selectedPage);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= state.pageOrder.length) return;
    [state.pageOrder[index], state.pageOrder[target]] = [state.pageOrder[target], state.pageOrder[index]];
    announce(`Page ${state.selectedPage} moved ${offset < 0 ? 'earlier' : 'later'} in the derived arrangement.`);
    render();
  }

  function removeSelectedPage() {
    if (state.pageOrder.length <= 1) {
      showError(new Error('A derived PDF must contain at least one page.'));
      return;
    }
    const index = state.pageOrder.indexOf(state.selectedPage);
    if (index < 0) return;
    state.pageOrder.splice(index, 1);
    const nextPage = state.pageOrder[Math.min(index, state.pageOrder.length - 1)];
    const changed = selectPage(nextPage, {
      announcement: 'Page removed from the derived arrangement. The source PDF is unchanged.',
    });
    if (!changed) {
      announce('Page removed from the derived arrangement. The source PDF is unchanged.');
      render();
    }
  }

  function restorePageOrder() {
    const pageCount = state.analysis.inspection?.pageCount ?? 0;
    if (!pageCount || pageCount > MAX_ARRANGEABLE_PAGES) return;
    state.pageOrder = Array.from({ length: pageCount }, (_, index) => index + 1);
    setSelectedPageIdentity(Math.min(state.selectedPage, pageCount));
    announce('Page arrangement reset to the source order.');
    render();
  }

  async function exportArrangement() {
    if (!state.analysis.documentId || !arrangementChanged() || state.busyAction) return;
    const operation = captureOperation();
    const pageOrder = [...state.pageOrder];
    const sourceSha256 = state.analysis.sha256;
    const pageCount = state.analysis.inspection?.pageCount ?? 0;
    state.busyAction = 'Creating arranged PDF…';
    state.error = null;
    render();
    try {
      const isOrderedSubset = pageOrder.every((page, index) => index === 0 || pageOrder[index - 1] < page);
      const removedPages = isOrderedSubset
        ? Array.from({ length: pageCount }, (_, index) => index + 1).filter((page) => !pageOrder.includes(page))
        : [];
      const artifact = removedPages.length > 0
        ? await client.deletePages(operation.documentId, sourceSha256, removedPages, { signal: operation.controller.signal })
        : await client.arrangePages(operation.documentId, sourceSha256, pageOrder, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const blob = await client.artifact(artifact.id, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      triggerDownload({
        blob,
        fileName: artifact.displayName,
        message: 'Arranged pages exported as a new PDF. The source is unchanged.',
      });
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { arrangementChanged, moveSelectedPage, removeSelectedPage, restorePageOrder, exportArrangement };
}
