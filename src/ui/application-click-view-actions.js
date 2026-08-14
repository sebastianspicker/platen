import { nextRotation, nextZoom, requestElementFullscreen } from '../core/ui-actions.js';
import { deriveViewerGridVisibility } from '../core/viewer-grid-overlay.js';
import { nextViewerPageLayout } from '../core/viewer-page-layout.js';

function createShellActions(context) {
  const {
    state,
    controllers: { viewer, lifecycle, tabs },
    documentApi,
    windowApi,
    render,
    downloadOriginal,
  } = context;
  return {
    'show-editor': () => viewer.setView('editor'),
    'show-workflows': async () => {
      await lifecycle.connectLocalHost().catch(() => {});
      viewer.setView('workflows');
    },
    'show-plugins': () => viewer.setView('plugins'),
    'show-about': () => viewer.setView('trust'),
    'open-file': () => documentApi.querySelector('#file-picker')?.click(),
    'choose-conversion-file': () => documentApi.querySelector('#conversion-picker')?.click(),
    'choose-combine-files': () => documentApi.querySelector('#combine-picker')?.click(),
    'choose-project-bundle': () => documentApi.querySelector('#project-bundle-picker')?.click(),
    'close-file': tabs?.closeTab ?? lifecycle.closeFile,
    'download-original': downloadOriginal,
    'print-document': () => windowApi.print(),
  };
}

function createDocumentTabActions(context) {
  const { controllers: { tabs } } = context;
  return {
    'activate-document-tab': (element) => tabs?.activateTab(element.dataset.tabId),
    'close-document-tab': (element) => tabs?.closeTab(element.dataset.tabId),
  };
}

function createViewerModeActions(context) {
  const { state, controllers: { viewer }, documentApi, render } = context;
  return {
    'toggle-controlled-render': () => viewer.setViewerMode(
      state.viewerMode === 'controlled' ? 'native' : 'controlled',
    ),
    'retry-controlled-render': () => { void viewer.loadControlledRaster(); },
    'toggle-reflow': () => viewer.setViewerMode(
      state.viewerMode === 'reflow' ? 'native' : 'reflow',
    ),
    'toggle-split-view': () => viewer.setViewerMode(
      state.viewerMode === 'split' ? 'native' : 'split',
    ),
    'cycle-page-layout': () => {
      state.viewerPageLayout = nextViewerPageLayout(state.viewerPageLayout ?? 'single');
      render();
    },
    'toggle-grid': () => {
      state.showGrid = deriveViewerGridVisibility({
        requested: !state.showGrid,
        document: state.document,
        analysis: state.analysis,
      });
      render();
    },
    'history-back': () => viewer.navigateHistory(-1),
    'history-forward': () => viewer.navigateHistory(1),
    'read-selected-page': viewer.readSelectedPage,
    'presentation-mode': async () => {
      state.presentationMode = !state.presentationMode;
      render();
      if (!state.presentationMode) return;
      try {
        await requestElementFullscreen(documentApi.querySelector('[data-drop-zone]'));
      } catch {
        // Presentation chrome still hides locally when fullscreen is unavailable.
      }
    },
  };
}

function createViewerOutputActions(context) {
  const { controllers: { viewer }, exportText, exportStructuredText } = context;
  return {
    'export-text': exportText,
    'export-structured-text': exportStructuredText,
    'export-page-image': viewer.exportSelectedPageImage,
    'copy-page-text': viewer.copySelectedPageText,
    'copy-page-snapshot': () => viewer.outputSelectedSnapshot('copy'),
    'download-page-snapshot': () => viewer.outputSelectedSnapshot('download'),
    'export-selected-region': () => viewer.outputSelectedSnapshot('export'),
    'refresh-loupe': viewer.refreshLoupe,
  };
}

function createViewportActions(context) {
  const {
    state,
    controllers: { documentOperations, pluginPlatform },
    documentApi,
    render,
    announce,
    showError,
  } = context;
  return {
    'cancel-operation': () => documentOperations.cancel(),
    'zoom-in': () => { state.zoom = nextZoom(state.zoom, 1); render(); },
    'zoom-out': () => { state.zoom = nextZoom(state.zoom, -1); render(); },
    'rotate-preview': () => { state.rotation = nextRotation(state.rotation); render(); },
    fullscreen: async () => {
      try {
        await requestElementFullscreen(documentApi.querySelector('[data-drop-zone]'));
      } catch (error) {
        showError(error);
      }
    },
    'dismiss-error': () => { state.error = null; render(); },
    'run-sandbox-probe': () => pluginPlatform.inspectSandbox(),
  };
}

export function createApplicationViewActions(context) {
  return {
    ...createDocumentTabActions(context),
    ...createShellActions(context),
    ...createViewerModeActions(context),
    ...createViewerOutputActions(context),
    ...createViewportActions(context),
  };
}
