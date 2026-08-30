function layerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeName(value, index) {
  if (value === null) return `Unnamed group ${index + 1}`;
  if (typeof value !== 'string' || value.length < 1 || value !== value.normalize('NFC')
    || [...value].length > 127 || new TextEncoder().encode(value).length > 512
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) {
    throw layerError('INVALID_PDFKIT_LAYER_INSPECTION', 'The optional-content inventory contains an unsafe layer name.');
  }
  return value;
}

function normalizeGroups(result, sourceDigest) {
  if (!result || result.kind !== 'pdfkit-structure-inspection' || result.sourceDigest !== sourceDigest) {
    throw layerError('STALE_PDFKIT_INSPECTION', 'Run the PDFKit inspection again to bind the layer controls to this source.');
  }
  const inventory = result.optionalContent;
  if (!inventory?.present) return Object.freeze([]);
  if (!Array.isArray(inventory.groups) || inventory.groupsTruncated === true
    || !Number.isSafeInteger(inventory.groupCount) || inventory.groupCount !== inventory.groups.length) {
    throw layerError('INVALID_PDFKIT_LAYER_INSPECTION', 'The optional-content inventory is incomplete or malformed.');
  }
  const seen = new Set();
  const groups = inventory.groups.map((group) => {
    if (!group || !Number.isSafeInteger(group.index) || group.index < 0
      || seen.has(group.index)
      || (group.defaultVisible !== null && typeof group.defaultVisible !== 'boolean')) {
      throw layerError('INVALID_PDFKIT_LAYER_INSPECTION', 'The optional-content inventory contains duplicate or malformed groups.');
    }
    seen.add(group.index);
    return Object.freeze({
      index: group.index,
      name: normalizeName(group.name, group.index),
      defaultVisible: group.defaultVisible,
    });
  });
  if (groups.some((group, index) => group.index !== index)) {
    throw layerError('INVALID_PDFKIT_LAYER_INSPECTION', 'The optional-content inventory is not in canonical order.');
  }
  return Object.freeze(groups);
}

function currentGroups(state) {
  const groups = state.pdfkitLayerGroups;
  if (!Array.isArray(groups) || groups.length === 0
    || state.pdfkitLayerInspectionDigest !== state.analysis?.sha256
    || state.pdfkitInspectionResult?.sourceDigest !== state.analysis?.sha256) return null;
  if (groups.some((group, index) => group.index !== index || typeof group.defaultVisible !== 'boolean')) return null;
  return groups;
}

export function createPdfKitLayerOperations({
  state, client, captureOperation, operationIsCurrent, reportOperationError,
  finishOperation, render, announce, downloadDerivedArtifact,
}) {
  function syncLayerInspection(result) {
    const groups = normalizeGroups(result, state.analysis?.sha256);
    state.pdfkitLayerGroups = groups;
    state.pdfkitLayerVisibility = groups.map(({ defaultVisible }) => defaultVisible);
    state.pdfkitLayerInspectionDigest = result.sourceDigest;
    state.pdfkitLayerStatus = 'idle';
    state.pdfkitLayerError = null;
    state.pdfkitLayerResult = null;
  }

  function setLayerVisibility(index, visible) {
    const groups = currentGroups(state);
    if (!groups || !Number.isSafeInteger(index) || !groups[index] || typeof visible !== 'boolean') return;
    const next = [...state.pdfkitLayerVisibility];
    next[index] = visible;
    state.pdfkitLayerVisibility = next;
    state.pdfkitLayerResult = null;
    state.pdfkitLayerStatus = 'idle';
    state.pdfkitLayerError = null;
  }

  function resetLayerVisibility() {
    const groups = currentGroups(state);
    if (!groups) return;
    state.pdfkitLayerVisibility = groups.map(({ defaultVisible }) => defaultVisible);
    state.pdfkitLayerResult = null;
    state.pdfkitLayerStatus = 'idle';
    state.pdfkitLayerError = null;
    render();
  }

  async function runLayerDefaults() {
    const groups = currentGroups(state);
    if (!groups || state.busyAction || state.host?.layerDefaultsReady !== true) return;
    if (groups.some(({ defaultVisible }) => typeof defaultVisible !== 'boolean')) return;
    const changes = groups
      .map((group, index) => ({ groupIndex: group.index, visible: state.pdfkitLayerVisibility[index] }))
      .filter(({ groupIndex, visible }) => visible !== groups[groupIndex].defaultVisible);
    if (!changes.length) return;
    const operation = captureOperation();
    state.busyAction = 'Creating and validating a layer-visibility PDF copy…';
    state.pdfkitLayerStatus = 'loading';
    state.pdfkitLayerError = null;
    state.pdfkitLayerResult = null;
    render();
    try {
      const result = await client.runLayerDefaults(
        operation.documentId,
        state.analysis.sha256,
        changes,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      const downloaded = await downloadDerivedArtifact(
        result.artifact,
        operation,
        `${result.artifact.displayName} created with verified optional-content defaults. The immutable source is unchanged.`,
      );
      if (!downloaded || !operationIsCurrent(operation)) return;
      state.pdfkitLayerResult = result;
      state.pdfkitLayerStatus = 'success';
      announce(`${result.artifact.displayName} created with verified layer visibility defaults. The source is unchanged.`);
    } catch (error) {
      state.pdfkitLayerStatus = error?.code === 'JOB_CANCELLED' || error?.status === 499
        ? 'cancelled' : 'error';
      state.pdfkitLayerError = error?.message ?? String(error);
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return Object.freeze({ syncLayerInspection, setLayerVisibility, resetLayerVisibility, runLayerDefaults });
}
