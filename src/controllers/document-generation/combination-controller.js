function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

async function prepareDocuments(context, files, operation, documentIds, inputIds) {
  const { state, client, operationIsCurrent, render } = context;
  for (const [index, file] of files.entries()) {
    if (!operationIsCurrent(operation)) return false;
    state.busyAction = [
      `Preparing file ${index + 1} of ${files.length}:`,
      `${file.name || 'local file'}…`,
    ].join(' ');
    render();
    let hosted;
    if (isPdf(file)) {
      hosted = await client.upload(file, { signal: operation.controller.signal });
    } else {
      const input = await client.uploadInput(file, {
        signal: operation.controller.signal,
      });
      inputIds.add(input.id);
      hosted = await client.convertInput(input.id, {
        signal: operation.controller.signal,
      });
    }
    documentIds.add(hosted.id);
  }
  return true;
}

async function mergePreparedDocuments(context, operation, documentIds) {
  const { state, client, operationIsCurrent, render, FileCtor } = context;
  let [combinedId, ...remainingIds] = [...documentIds];
  for (const [index, secondaryId] of remainingIds.entries()) {
    if (!operationIsCurrent(operation)) {
      return { stale: true, combinedId: null };
    }
    state.busyAction = `Combining PDF ${index + 2} of ${documentIds.size}…`;
    render();
    const artifact = await client.mergeDocuments(combinedId, secondaryId, {
      signal: operation.controller.signal,
    });
    const blob = await client.artifact(artifact.id, {
      signal: operation.controller.signal,
    });
    const intermediate = new FileCtor(
      [blob],
      `combined-${index + 2}.pdf`,
      { type: 'application/pdf' },
    );
    const hosted = await client.upload(intermediate, {
      signal: operation.controller.signal,
    });
    documentIds.add(hosted.id);
    combinedId = hosted.id;
  }
  return { stale: false, combinedId };
}

function combinedFile(context, blob) {
  const { state, FileCtor } = context;
  const title = state.creationTitle.trim() || 'Combined document';
  const name = title.replace(/[^a-z0-9._ -]+/gi, '-').slice(0, 120) || 'combined';
  return new FileCtor([blob], `${name}.pdf`, { type: 'application/pdf' });
}

async function cleanupInputsAndDocuments(context, inputIds, documentIds) {
  const { client, removeHostDocument } = context;
  await Promise.all([...inputIds].map((id) => client.deleteInput(id).catch(() => {})));
  await Promise.all([...documentIds].map((id) => removeHostDocument(id)));
}

async function runCombineMixedFiles(context, fileList) {
  const {
    state,
    client,
    connectLocalHost,
    openFile,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    render,
    announce,
    showError,
    documentApi,
  } = context;
  const files = Array.from(fileList ?? []);
  if (state.busyAction) return;
  if (files.length < 2 || files.length > 16) {
    showError(new Error('Choose from two through 16 supported local files to combine.'));
    return;
  }
  const operation = captureOperation();
  state.busyAction = `Preparing ${files.length} local files for combination…`;
  state.error = null;
  render();
  const documentIds = new Set();
  const inputIds = new Set();
  try {
    await connectLocalHost();
    const prepared = await prepareDocuments(
      context,
      files,
      operation,
      documentIds,
      inputIds,
    );
    if (!prepared) return;
    const mergeResult = await mergePreparedDocuments(context, operation, documentIds);
    if (mergeResult.stale) return;
    const { combinedId } = mergeResult;
    const blob = await client.documentSource(combinedId, {
      signal: operation.controller.signal,
    });
    if (!operationIsCurrent(operation)) return;
    const file = combinedFile(context, blob);
    announce(
      `${files.length} local files combined into a validated PDF. Every source is unchanged.`,
    );
    await openFile(file);
  } catch (error) {
    reportOperationError(error, operation);
  } finally {
    await cleanupInputsAndDocuments(context, inputIds, documentIds);
    const picker = documentApi.querySelector('#combine-picker');
    if (picker) {
      picker.value = '';
    }
    finishOperation(operation);
  }
}

export function createDocumentCombinationController(options) {
  const context = { ...options };
  async function combineMixedFiles(files) {
    return runCombineMixedFiles(context, files);
  }
  return Object.freeze({ combineMixedFiles });
}
