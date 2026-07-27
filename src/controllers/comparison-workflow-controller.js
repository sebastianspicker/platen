import { spreadsheetSafeCsvCell } from '../core/spreadsheet-safe-csv.js';

function comparisonInputs(report) {
  const inputs = report?.inputs;
  const digest = /^[a-f0-9]{64}$/u;
  if (!Array.isArray(inputs) || inputs.length !== 2
    || inputs[0]?.role !== 'primary' || inputs[1]?.role !== 'secondary'
    || !digest.test(inputs[0]?.sha256 ?? '') || !digest.test(inputs[1]?.sha256 ?? '')) {
    throw new TypeError('Comparison CSV requires two ordered source-digest bindings.');
  }
  return inputs;
}

export function comparisonCsv(report) {
  const effective = report?.kind === 'cross-format' ? report.content : report;
  const inputs = comparisonInputs(effective);
  const rows = [['primarySha256', 'secondarySha256', 'kind', 'page', 'status', 'added', 'deleted', 'unchanged', 'changedPixels', 'comparedPixels']];
  for (const page of effective?.pages ?? []) {
    rows.push([
      inputs[0].sha256,
      inputs[1].sha256,
      effective.kind ?? '',
      page.page ?? '',
      page.status ?? '',
      page.stats?.added ?? '',
      page.stats?.deleted ?? '',
      page.stats?.unchanged ?? '',
      page.changedPixels ?? '',
      page.comparedPixels ?? '',
    ]);
  }
  if (rows.length === 1) {
    rows.push([inputs[0].sha256, inputs[1].sha256, effective?.kind ?? report?.kind ?? '', '', report?.status ?? '', '', '', '', '', '']);
  }
  return `${rows.map((row) => row.map(spreadsheetSafeCsvCell).join(',')).join('\n')}\n`;
}

export function createComparisonWorkflowController({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  removeHostDocument,
  triggerDownload,
  render,
  announce,
  document: browserDocument = globalThis.document,
  Blob: BlobConstructor = Blob,
  JSON: json = JSON,
}) {
  const callbacks = {
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    removeHostDocument,
    triggerDownload,
    render,
    announce,
  };
  if (!state || !client || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('Comparison workflow controller requires state, client, and workflow callbacks.');
  }

  async function compareWithFile(file) {
    if (!state.analysis.documentId || !file || state.busyAction) return;
    const operation = captureOperation();
    const mode = state.comparisonMode;
    state.busyAction = `Comparing ${file.name || 'local PDF'} locally…`;
    state.error = null;
    state.comparisonReport = null;
    state.comparisonFileName = null;
    render();
    let secondary = null;
    try {
      secondary = await client.upload(file, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const options = mode === 'pixel'
        ? { pages: [state.selectedPage], dpi: 72 }
        : mode === 'overlay'
          ? { page: state.selectedPage, opacity: 0.5 }
          : mode === 'side-by-side'
            ? { page: state.selectedPage }
            : {};
      const report = await client.compareDocuments(
        operation.documentId,
        secondary.id,
        mode,
        options,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      state.comparisonReport = report;
      state.comparisonFileName = file.name || 'Comparison PDF';
      announce(`${mode} comparison completed locally. Both PDFs are unchanged.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      if (secondary?.id) await removeHostDocument(secondary.id);
      const picker = browserDocument?.querySelector?.('#comparison-picker');
      if (picker) picker.value = '';
      finishOperation(operation);
    }
  }

  function exportComparison(format) {
    if (!state.comparisonReport) return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
    const data = format === 'csv'
      ? comparisonCsv(state.comparisonReport)
      : `${json.stringify(state.comparisonReport, null, 2)}\n`;
    const blob = new BlobConstructor([data], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    });
    triggerDownload({
      blob,
      fileName: `${stem}-comparison.${format}`,
      message: `Local comparison report exported as ${format.toUpperCase()}.`,
    });
  }

  return Object.freeze({ compareWithFile, exportComparison });
}
