import { readDerivedDocument } from './derived-document.js';
import {
  assertClipboardPngBlob,
  assertSingleClipboardPngItem,
} from '../../core/clipboard-image-contract.js';

function hexDigest(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function digestBlob(blob, cryptoApi) {
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== 'function') {
    throw new Error('The browser cannot verify the local clipboard PDF digest.');
  }
  return hexDigest(await cryptoApi.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

function conversionBoundToInput(document, input) {
  const sources = document?.operation?.inputs;
  if (!Array.isArray(sources) || sources.length !== 1) return false;
  const [source] = sources;
  return source?.assetId === input?.id && source?.sha256 === input?.sha256;
}

async function runCreateLocalDocument(context, kind) {
  const {
    state,
    client,
    connectLocalHost,
    openFile,
    removeHostDocument,
    captureOperation,
    reportOperationError,
    finishOperation,
    render,
  } = context;
  if (state.busyAction) return;
  const operation = captureOperation();
  state.busyAction = kind === 'blank'
    ? 'Creating a blank local PDF…'
    : 'Creating a local text PDF…';
  state.error = null;
  render();
  let hosted = null;
  try {
    await connectLocalHost();
    if (kind === 'blank') {
      const pages = Number(state.blankPageCount);
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500) {
        throw new Error('Blank page count must be an integer from 1 through 500.');
      }
      hosted = await client.createBlank(
        { pages, title: state.creationTitle },
        { signal: operation.controller.signal },
      );
    } else {
      hosted = await client.createText(
        { text: state.creationText, title: state.creationTitle },
        { signal: operation.controller.signal },
      );
    }
    const file = await readDerivedDocument(context, hosted, operation);
    hosted = null;
    if (file) {
      await openFile(file);
    }
  } catch (error) {
    if (hosted?.id) {
      await removeHostDocument(hosted.id);
    }
    reportOperationError(error, operation);
  } finally {
    finishOperation(operation);
  }
}

async function readClipboardDocument(context) {
  const { state, navigatorApi, showError } = context;
  if (state.busyAction) return;
  if (!navigatorApi?.clipboard || typeof navigatorApi.clipboard.readText !== 'function') {
    showError(new Error(
      'Clipboard reading is unavailable in this browser. Paste into the text field instead.',
    ));
    return;
  }
  try {
    const text = await navigatorApi.clipboard.readText();
    if (!text.trim()) {
      throw new Error('The clipboard does not contain text.');
    }
    if (text.length > 1_000_000) {
      throw new Error('Clipboard text exceeds the one-million-character local limit.');
    }
    state.creationText = text;
    await runCreateLocalDocument(context, 'text');
  } catch (error) {
    showError(error);
  }
}

async function runCreateClipboardImage(context) {
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
    navigatorApi,
    FileCtor,
    cryptoApi,
  } = context;
  if (state.busyAction) return;
  const operation = captureOperation();
  state.busyAction = 'Creating a one-page PDF from the clipboard PNG…';
  state.error = null;
  render();
  let input = null;
  let hosted = null;
  let pendingFile = null;
  let operationError = null;
  const collectError = (error) => {
    if (!error) return;
    operationError = operationError
      ? new AggregateError([operationError, error], 'Clipboard PDF creation and cleanup failed.')
      : error;
  };
  try {
    if (!navigatorApi?.clipboard || typeof navigatorApi.clipboard.read !== 'function') {
      throw new Error('Clipboard image reading is unavailable in this browser.');
    }
    const items = await navigatorApi.clipboard.read();
    if (!operationIsCurrent(operation)) return;
    const item = assertSingleClipboardPngItem(items, 'Clipboard PDF creation');
    const imageBlob = await item.getType('image/png');
    if (!operationIsCurrent(operation)) return;
    assertClipboardPngBlob(imageBlob, { label: 'Clipboard PDF creation', BlobCtor: Blob });
    if (typeof FileCtor !== 'function') {
      throw new Error('The browser cannot create local clipboard input assets.');
    }
    await connectLocalHost();
    if (!operationIsCurrent(operation)) return;
    input = await client.uploadInput(new FileCtor([imageBlob], 'clipboard-image.png', {
      type: 'image/png',
    }), { signal: operation.controller.signal });
    if (!operationIsCurrent(operation)) return;
    hosted = await client.convertInput(input.id, { signal: operation.controller.signal });
    if (!operationIsCurrent(operation)) return;
    if (hosted?.operation?.validation?.pageCount !== 1 || !conversionBoundToInput(hosted, input)) {
      const error = new Error('Clipboard PNG conversion did not produce a source-bound one-page PDF.');
      error.code = 'INVALID_CLIPBOARD_PDF_CONVERSION';
      throw error;
    }
    const sourceBlob = await client.documentSource(hosted.id, {
      signal: operation.controller.signal,
    });
    if (!operationIsCurrent(operation)) return;
    const sourceDigest = await digestBlob(sourceBlob, cryptoApi);
    if (sourceDigest !== hosted.sha256) {
      const error = new Error('The clipboard PDF output failed immutable digest verification.');
      error.code = 'INVALID_CLIPBOARD_PDF_DIGEST';
      throw error;
    }
    pendingFile = new FileCtor(
      [sourceBlob],
      hosted.displayName || 'clipboard-image.pdf',
      { type: 'application/pdf' },
    );
  } catch (error) {
    collectError(error);
  } finally {
    const cleanup = [];
    if (hosted?.id) cleanup.push(() => removeHostDocument(hosted.id));
    if (input?.id) cleanup.push(() => client.deleteInput(input.id));
    const cleanupOutcomes = await Promise.allSettled(cleanup.map((task) => task()));
    cleanupOutcomes
      .filter(({ status }) => status === 'rejected')
      .forEach(({ reason }) => collectError(reason));
    if (!operationError && pendingFile && operationIsCurrent(operation)) {
      await openFile(pendingFile).catch(collectError);
    }
    if (operationError && operationIsCurrent(operation)) reportOperationError(operationError, operation);
    finishOperation(operation);
  }
}

export function createDocumentCreationController(options) {
  const context = { ...options };
  async function createLocalDocument(kind) {
    return runCreateLocalDocument(context, kind);
  }
  async function createFromClipboard() {
    return readClipboardDocument(context);
  }
  async function createClipboardToPdf() {
    return runCreateClipboardImage(context);
  }
  return Object.freeze({ createLocalDocument, createFromClipboard, createClipboardToPdf });
}
