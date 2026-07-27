import { normalizedRectangle } from '../../core/normalized-rectangle.js';
import { sourceBoundRedactionPlans } from '../../core/redaction-plan-contract.js';

function selectedPlan(state) {
  return state.redactionPlans.find(({ id }) => id === state.selectedRedactionPlanId) ?? null;
}

function selectedMark(state, plan = selectedPlan(state)) {
  return plan?.marks.find(({ id }) => id === state.selectedRedactionMarkId) ?? null;
}

function synchronizeSelection(state) {
  const plan = selectedPlan(state) ?? state.redactionPlans[0] ?? null;
  state.selectedRedactionPlanId = plan?.id ?? '';
  const mark = selectedMark(state, plan) ?? plan?.marks[0] ?? null;
  state.selectedRedactionMarkId = mark?.id ?? '';
}

async function exportRedactionPlanReportOperation({
  state, client, captureOperation, operationIsCurrent, reportOperationError,
  finishOperation, render, announce, jsonDownload,
}) {
  const plan = selectedPlan(state);
  if (!state.analysis.documentId || state.busyAction || !plan
    || state.host?.redactionPlanReportsReady !== true) return;
  const operation = captureOperation();
  state.busyAction = 'Preparing a source-bound redaction proposal report…';
  state.error = null;
  render();
  try {
    const report = await client.exportRedactionPlanReport(operation.documentId, {
      sourceSha256: state.analysis.sha256,
      expectedWorkspaceRevision: state.domainRevision,
      planId: plan.id,
      planSha256: plan.planSha256,
    }, { signal: operation.controller.signal });
    if (!operationIsCurrent(operation)) return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/iu, '');
    jsonDownload(
      report,
      `${stem}-redaction-proposal-report.json`,
      'Source-bound proposed-not-applied redaction report exported as JSON.',
    );
    announce('Redaction proposal report exported. No PDF bytes were changed.');
  } catch (error) {
    reportOperationError(error, operation);
  } finally {
    finishOperation(operation);
  }
}

export function createRedactionPlanOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  downloadDerivedArtifact,
  render,
  announce,
  showError,
  confirm,
  jsonDownload,
}) {
  function syncRedactionPlans(workspace) {
    state.redactionPlans = [...sourceBoundRedactionPlans(workspace, state.analysis.sha256)];
    synchronizeSelection(state);
  }

  function selectRedactionPlan(planId) {
    if (!state.redactionPlans.some(({ id }) => id === planId)) return;
    state.selectedRedactionPlanId = planId;
    state.selectedRedactionMarkId = selectedPlan(state)?.marks[0]?.id ?? '';
  }

  function selectRedactionMark(markId) {
    if (!selectedPlan(state)?.marks.some(({ id }) => id === markId)) return;
    state.selectedRedactionMarkId = markId;
  }

  function currentTarget() {
    const page = state.selectedPage;
    return state.redactionFullPage
      ? { page, fullPage: true }
      : { page, region: normalizedRectangle(state.redactionRegion, 'Redaction plan') };
  }

  async function createRedactionPlan() {
    if (!state.analysis.documentId || state.busyAction || !state.host?.redactionPlansReady) return;
    let target;
    try {
      target = currentTarget();
    } catch (error) {
      showError(error);
      return;
    }
    if (!confirm('Store this selected-page geometry as a source-bound redaction proposal? The host will inspect the immutable source locally and retain only keyed text-binding evidence, never the extracted text. No PDF bytes will change.')) return;
    const operation = captureOperation();
    state.busyAction = 'Creating a source-bound redaction proposal…';
    state.error = null;
    render();
    try {
      const result = await client.createRedactionPlan(operation.documentId, {
        sourceSha256: state.analysis.sha256,
        expectedWorkspaceRevision: state.domainRevision,
        targets: [target],
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.domainRevision = result.revision;
      syncRedactionPlans({ namespaces: { redactions: [...state.redactionPlans, result.plan] } });
      state.selectedRedactionPlanId = result.plan.id;
      state.selectedRedactionMarkId = result.plan.marks[0].id;
      announce('Source-bound redaction proposal stored locally. No PDF bytes were changed.');
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  async function applyRedactionPlan() {
    const plan = selectedPlan(state);
    const mark = selectedMark(state, plan);
    if (!state.analysis.documentId || state.busyAction || !plan || !mark) return;
    const target = mark.fullPage === true ? `all of page ${mark.page}` : `the reviewed region on page ${mark.page}`;
    if (!confirm(`Create a separate image-only PDF by irreversibly blacking out ${target}? The source and proposal remain unchanged. Vectors, forms, links, tags, layers, and signatures will not be preserved in the derived copy.`)) return;
    const operation = captureOperation();
    state.busyAction = 'Applying and validating the selected redaction proposal…';
    state.error = null;
    render();
    try {
      const result = await client.applyRedactionPlan(operation.documentId, {
        sourceSha256: state.analysis.sha256,
        expectedWorkspaceRevision: state.domainRevision,
        planId: plan.id,
        planSha256: plan.planSha256,
        markIds: [mark.id],
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      await downloadDerivedArtifact(
        result.artifact,
        operation,
        'Source-bound plan geometry was raster-burned and validated in a separate image-only PDF. The proposal remains proposed, and the immutable source is unchanged.',
      );
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  const exportRedactionPlanReport = () => exportRedactionPlanReportOperation({
    state, client, captureOperation, operationIsCurrent, reportOperationError,
    finishOperation, render, announce, jsonDownload,
  });

  return Object.freeze({
    syncRedactionPlans,
    selectRedactionPlan,
    selectRedactionMark,
    createRedactionPlan,
    applyRedactionPlan,
    exportRedactionPlanReport,
  });
}
