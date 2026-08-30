import { createDocumentCombinationController } from './document-generation/combination-controller.js';
import { createDocumentConversionController } from './document-generation/conversion-controller.js';
import { createDocumentCreationController } from './document-generation/create-controller.js';
import { createDocumentRewriteController } from './document-generation/rewrite-controller.js';

export function createDocumentGenerationController({
  state,
  client,
  connectLocalHost,
  openFile,
  removeHostDocument,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
  announce,
  showError,
  document: documentApi = globalThis.document,
  navigator: navigatorApi = globalThis.navigator,
  File: FileCtor = globalThis.File,
  crypto: cryptoApi = globalThis.crypto,
}) {
  const callbacks = {
    connectLocalHost,
    openFile,
    removeHostDocument,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    triggerDownload,
    render,
    announce,
    showError,
  };
  if (
    !state
    || !client
    || !documentApi
    || typeof FileCtor !== 'function'
    || Object.values(callbacks).some((callback) => typeof callback !== 'function')
  ) {
    throw new TypeError(
      'Document generation controller requires state, client, browser APIs, and callbacks.',
    );
  }

  const context = {
    state,
    client,
    connectLocalHost,
    openFile,
    removeHostDocument,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    triggerDownload,
    render,
    announce,
    showError,
    documentApi,
    navigatorApi,
    FileCtor,
    cryptoApi,
  };
  const creation = createDocumentCreationController(context);
  const conversion = createDocumentConversionController(context);
  const combination = createDocumentCombinationController(context);
  const rewrite = createDocumentRewriteController(context);

  return Object.freeze({
    createLocalDocument: creation.createLocalDocument,
    createFromClipboard: creation.createFromClipboard,
    createClipboardToPdf: creation.createClipboardToPdf,
    convertLocalFile: conversion.convertLocalFile,
    combineMixedFiles: combination.combineMixedFiles,
    rewriteLocalDocument: rewrite.rewriteLocalDocument,
  });
}
