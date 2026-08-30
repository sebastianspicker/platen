import { readDerivedDocument } from './derived-document.js';

async function runConvertLocalFile(context, file) {
  const {
    state,
    client,
    connectLocalHost,
    openFile,
    removeHostDocument,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    render,
    documentApi,
  } = context;
  if (!file || state.busyAction) return;
  const operation = captureOperation();
  state.busyAction = `Converting ${file.name || 'local file'} to PDF…`;
  state.error = null;
  render();
  let input = null;
  let hosted = null;
  try {
    await connectLocalHost();
    input = await client.uploadInput(file, { signal: operation.controller.signal });
    if (!operationIsCurrent(operation)) return;
    hosted = await client.convertInput(input.id, { signal: operation.controller.signal });
    const converted = await readDerivedDocument(context, hosted, operation);
    hosted = null;
    if (converted) {
      await openFile(converted);
    }
  } catch (error) {
    if (hosted?.id) {
      await removeHostDocument(hosted.id);
    }
    reportOperationError(error, operation);
  } finally {
    if (input?.id) {
      await client.deleteInput(input.id).catch(() => {});
    }
    const picker = documentApi.querySelector('#conversion-picker');
    if (picker) {
      picker.value = '';
    }
    finishOperation(operation);
  }
}

export function createDocumentConversionController(options) {
  const context = { ...options };
  async function convertLocalFile(file) {
    return runConvertLocalFile(context, file);
  }
  return Object.freeze({ convertLocalFile });
}
