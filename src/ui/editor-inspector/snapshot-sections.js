import { escapeHtml } from '../shared.js';
import { loupeResult } from '../editor-result-views.js';

export function snapshotSections(state, { ready, snapshotReady, loupeReady }) {
  return `
      <section class="property-section snapshot-section">
        <h3>Rendered region snapshot</h3>
        <p class="field-help">Choose a normalized rectangle on page ${escapeHtml(state.selectedPage ?? 1)}. X and Y start at the top-left of the passive CropBox raster; these are not PDF point coordinates.</p>
        <div class="numeric-grid" aria-label="Normalized top-left snapshot region">
          <label>X <input id="snapshot-x" type="number" min="0" max="0.99" step="0.01" value="${escapeHtml(state.snapshotRegion?.x ?? 0.1)}" ${ready ? '' : 'disabled'} /></label>
          <label>Y <input id="snapshot-y" type="number" min="0" max="0.99" step="0.01" value="${escapeHtml(state.snapshotRegion?.y ?? 0.1)}" ${ready ? '' : 'disabled'} /></label>
          <label>Width <input id="snapshot-width" type="number" min="0.01" max="1" step="0.01" value="${escapeHtml(state.snapshotRegion?.width ?? 0.8)}" ${ready ? '' : 'disabled'} /></label>
          <label>Height <input id="snapshot-height" type="number" min="0.01" max="1" step="0.01" value="${escapeHtml(state.snapshotRegion?.height ?? 0.8)}" ${ready ? '' : 'disabled'} /></label>
        </div>
        <label class="field-label" for="snapshot-dpi">Raster DPI</label>
        <input id="snapshot-dpi" type="number" min="36" max="240" step="1" value="${escapeHtml(state.snapshotDpi ?? 192)}" ${ready ? '' : 'disabled'} />
        <div class="button-row" role="group" aria-label="Snapshot output">
          <button class="button primary" data-action="copy-page-snapshot" ${snapshotReady && state.snapshotClipboardReady ? '' : 'disabled'}>Copy PNG</button>
          <button class="button" data-action="download-page-snapshot" ${snapshotReady ? '' : 'disabled'}>Download PNG</button>
          <button class="button" data-action="export-selected-region" ${snapshotReady ? '' : 'disabled'}>Export selected region</button>
        </div>
        <p class="field-help">The service renders the selected page CropBox locally with Poppler, then covers the requested raster region using floor for left/top and ceil for right/bottom pixel edges. The result is a separate bounded PNG; the PDF is not changed. Selectable text, vectors, links, tags, layers, forms, and PDF object structure are not present in the image.${state.snapshotClipboardReady ? '' : ' PNG clipboard writing is unavailable in this browser; download remains available.'}</p>
      </section>
      <section class="property-section loupe-section">
        <h3>Loupe</h3>
        <button class="button" data-action="refresh-loupe" ${loupeReady ? '' : 'disabled'}>Refresh magnified region</button>
        ${loupeResult(state)}
        <p class="field-help">Uses the normalized region above at a fixed 240 DPI while the native full-page preview remains visible. This is a magnified passive CropBox PNG, not selectable text or vector, link, tag, form, layer, or PDF-object inspection. The source PDF is unchanged.${state.viewerMode === 'native' ? '' : ' Return to the native preview to retain full-page context.'}</p>
      </section>`;
}
