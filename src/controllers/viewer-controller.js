import { createViewerNavigationController } from './viewer/navigation-controller.js';
import { createViewerOutputController } from './viewer/output-controller.js';
import { createViewerRasterController } from './viewer/raster-controller.js';
import { createViewerStateController } from './viewer/view-state-controller.js';

export function createViewerController({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  clearOcrLayoutSelection,
  render,
  announce,
  showError,
  document: documentApi = globalThis.document,
  window: windowApi = globalThis.window,
  navigator: navigatorApi = globalThis.navigator,
  urlApi = globalThis.URL,
}) {
  const callbacks = {
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    triggerDownload,
    clearOcrLayoutSelection,
    render,
    announce,
    showError,
  };
  if (
    !state
    || !client
    || !documentApi
    || !windowApi
    || !urlApi
    || Object.values(callbacks).some((callback) => typeof callback !== 'function')
  ) {
    throw new TypeError('Viewer controller requires state, client, browser APIs, and callbacks.');
  }

  const selectionTracker = { generation: 0 };
  const raster = createViewerRasterController({
    state,
    client,
    render,
    announce,
    showError,
    windowApi,
    urlApi,
  });
  const viewState = createViewerStateController({
    state,
    resetLoupe: raster.resetLoupe,
    render,
    documentApi,
    urlApi,
  });
  const navigation = createViewerNavigationController({
    state,
    selectionTracker,
    resetLoupe: raster.resetLoupe,
    loadControlledRaster: raster.loadControlledRaster,
    clearOcrLayoutSelection,
    render,
    announce,
  });
  const output = createViewerOutputController({
    state,
    client,
    selectionTracker,
    decodeControlledRaster: raster.decodeControlledRaster,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    triggerDownload,
    render,
    announce,
    showError,
    documentApi,
    windowApi,
    navigatorApi,
  });

  return Object.freeze({
    resetControlledRaster: raster.resetControlledRaster,
    resetLoupe: raster.resetLoupe,
    refreshLoupe: raster.refreshLoupe,
    loadControlledRaster: raster.loadControlledRaster,
    setViewerMode: raster.setViewerMode,
    setView: viewState.setView,
    revokeThumbnails: viewState.revokeThumbnails,
    updateSearchResults: viewState.updateSearchResults,
    setSelectedPageIdentity: navigation.setSelectedPageIdentity,
    selectPage: navigation.selectPage,
    navigateHistory: navigation.navigateHistory,
    readSelectedPage: output.readSelectedPage,
    exportSelectedPageImage: output.exportSelectedPageImage,
    copySelectedPageText: output.copySelectedPageText,
    outputSelectedSnapshot: output.outputSelectedSnapshot,
  });
}
