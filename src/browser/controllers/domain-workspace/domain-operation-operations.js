import { domainPayloadTemplate } from '../../core/domain-templates.js';

export function createDomainOperationOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  finishOperation,
  render,
  announce,
}) {
  function selectDomainOperation(group, operation) {
    const entry = state.domainOperations?.[group]?.[operation];
    if (!entry?.supported) return;
    state.selectedDomainOperation = { group, operation };
    state.domainPayload = domainPayloadTemplate(group, operation, {
      revision: state.domainRevision,
      documentDigest: state.analysis.sha256 || undefined,
    });
    state.domainResult = null;
    state.domainError = null;
    render();
  }

  async function runDomainOperation() {
    const selected = state.selectedDomainOperation;
    if (!state.analysis.documentId || !selected || state.domainBusy) return;
    let body;
    try {
      body = JSON.parse(state.domainPayload || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('The workflow body must be a JSON object.');
      }
    } catch (error) {
      state.domainError = error.message;
      state.domainResult = null;
      render();
      return;
    }
    const operation = captureOperation();
    state.domainBusy = true;
    state.domainError = null;
    state.domainResult = null;
    render();
    try {
      const result = await client.executeDomain(
        operation.documentId,
        selected.group,
        selected.operation,
        body,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      state.domainResult = result;
      const nextRevision = result?.revision ?? result?.snapshot?.revision;
      if (Number.isSafeInteger(nextRevision)) state.domainRevision = nextRevision;
      announce(`${selected.group} ${selected.operation} completed in the local session.`);
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      state.domainError = operation.controller.signal.aborted
        ? 'The local workflow was cancelled.'
        : error.message;
    } finally {
      if (operationIsCurrent(operation)) state.domainBusy = false;
      finishOperation(operation);
    }
  }

  return { selectDomainOperation, runDomainOperation };
}
