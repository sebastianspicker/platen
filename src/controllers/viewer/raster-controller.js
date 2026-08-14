import { ControlledRasterSession } from '../../core/controlled-raster-session.js';
import { normalizeSnapshotRegion } from '../../core/snapshot-output.js';

const LOUPE_DPI = 240;

export function createControlledRasterDecoder({ windowApi, urlApi }) {
  return async function decodeControlledRaster(blob) {
    if (typeof windowApi.createImageBitmap === 'function') {
      const bitmap = await windowApi.createImageBitmap(blob);
      try {
        if (!bitmap.width || !bitmap.height) {
          throw new Error('The local renderer returned an empty page image.');
        }
      } finally {
        bitmap.close();
      }
      return;
    }

    const temporaryUrl = urlApi.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const image = new windowApi.Image();
        image.onload = () => (image.naturalWidth && image.naturalHeight
          ? resolve()
          : reject(new Error('The local renderer returned an empty page image.')));
        image.onerror = () => reject(
          new Error('The local renderer returned an unreadable page image.'),
        );
        image.src = temporaryUrl;
      });
    } finally {
      urlApi.revokeObjectURL(temporaryUrl);
    }
  };
}

function snapshotRegion(state) {
  return normalizeSnapshotRegion(Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [
      key,
      Number(state.snapshotRegion?.[key]),
    ]),
  ));
}

function createSetViewerMode({ state, resetControlledRaster, resetLoupe, loadControlledRaster, render }) {
  return function setViewerMode(mode) {
    if (!['native', 'reflow', 'split', 'controlled'].includes(mode)) return;
    if (state.viewerMode === 'controlled' && mode !== 'controlled') {
      resetControlledRaster('Controlled raster mode closed.');
    }
    if (mode !== 'native') resetLoupe('The loupe requires the native full-page context.');
    state.viewerMode = mode;
    if (mode === 'controlled') void loadControlledRaster();
    else render();
  };
}

export function createViewerRasterController({
  state,
  client,
  render,
  announce,
  showError,
  windowApi,
  urlApi,
}) {
  let loupeRequestRegion = null;
  const decodeControlledRaster = createControlledRasterDecoder({ windowApi, urlApi });

  const controlledRasterSession = new ControlledRasterSession({
    fetchPage: (documentId, page, dpi, options) => (
      client.cropBoxRaster(documentId, page, dpi, options)
    ),
    decodeBlob: decodeControlledRaster,
    createObjectUrl: (blob) => urlApi.createObjectURL(blob),
    revokeObjectUrl: (url) => urlApi.revokeObjectURL(url),
    onChange: (snapshot) => {
      state.controlledRaster = snapshot;
      if (state.registry) render();
    },
  });

  const loupeRasterSession = new ControlledRasterSession({
    fetchPage: (documentId, page, dpi, options) => {
      if (!loupeRequestRegion) {
        throw new Error('Choose a valid normalized region before refreshing the loupe.');
      }
      return client.cropBoxSnapshot(documentId, page, loupeRequestRegion, dpi, options);
    },
    decodeBlob: decodeControlledRaster,
    createObjectUrl: (blob) => urlApi.createObjectURL(blob),
    revokeObjectUrl: (url) => urlApi.revokeObjectURL(url),
    onChange: (snapshot) => {
      state.loupeRaster = snapshot;
      if (state.registry) render();
    },
  });

  function resetControlledRaster(reason) {
    state.controlledRaster = controlledRasterSession.reset(reason, { notify: false });
  }

  function resetLoupe(reason) {
    loupeRequestRegion = null;
    state.loupeRaster = loupeRasterSession.reset(reason, { notify: false });
  }

  async function refreshLoupe() {
    if (
      state.viewerMode !== 'native'
      || state.analysis.status !== 'ready'
      || !state.analysis.documentId
      || state.busyAction
    ) return;
    try {
      loupeRequestRegion = snapshotRegion(state);
    } catch (error) {
      showError(error);
      return;
    }
    const page = state.selectedPage;
    const result = await loupeRasterSession.load(
      state.analysis.documentId,
      page,
      { dpi: LOUPE_DPI },
    );
    if (
      result?.status === 'ready'
      && state.viewerMode === 'native'
      && state.selectedPage === page
      && state.loupeRaster === result
    ) {
      announce(`Magnified passive raster region ready for page ${page}.`);
    }
  }

  async function loadControlledRaster(page = state.selectedPage) {
    if (
      state.viewerMode !== 'controlled'
      || state.analysis.status !== 'ready'
      || !state.analysis.documentId
    ) return;
    const result = await controlledRasterSession.load(state.analysis.documentId, page);
    if (
      result?.status === 'ready'
      && state.viewerMode === 'controlled'
      && result.page === page
      && state.controlledRaster === result
    ) {
      announce(`Passive local raster preview ready for page ${page}.`);
    }
  }

  const setViewerMode = createSetViewerMode({
    state,
    resetControlledRaster,
    resetLoupe,
    loadControlledRaster,
    render,
  });

  return Object.freeze({
    decodeControlledRaster,
    resetControlledRaster,
    resetLoupe,
    refreshLoupe,
    loadControlledRaster,
    setViewerMode,
  });
}
