import { icon } from '../icons.js';
import { escapeHtml } from '../shared.js';
import { ocrBatchResult, ocrCopyResult, ocrLayoutResult } from '../editor-result-views.js';

function ocrZoneEditor(state, ocrLayoutReady) {
  const selectedPage = state.selectedPage ?? 1;
  const zone = (state.ocrZones ?? []).find(
    (item) => item.id === state.selectedOcrZoneId && item.page === selectedPage,
  );
  if (!zone) return '';

  const disabled = ocrLayoutReady ? '' : 'disabled';
  const typeOptions = ['text', 'table', 'image', 'exclude']
    .map((type) => (
      '<option value="' + type + '" '
      + (zone.type === type ? 'selected' : '')
      + '>' + type + '</option>'
    ))
    .join('');
  const numericInput = (name, label, min, max, value) => (
    '<label>' + label
    + ' <input id="ocr-zone-' + name
    + '" type="number" min="' + min
    + '" max="' + max + '" step="0.01" value="' + escapeHtml(value)
    + '" ' + disabled + ' /></label>'
  );

  return '<div class="numeric-grid" aria-label="Normalized OCR zone">'
    + '<label>Type <select id="ocr-zone-type" ' + disabled + '>'
    + typeOptions
    + '</select></label>'
    + numericInput('x', 'X', '0', '0.99', zone.x)
    + numericInput('y', 'Y', '0', '0.99', zone.y)
    + numericInput('width', 'Width', '0.01', '1', zone.width)
    + numericInput('height', 'Height', '0.01', '1', zone.height)
    + '</div>';
}

export function ocrSections(state, analysis, readiness) {
  const { ocrLanguages, ocrCopyReady, ocrLayoutReady, rasterAvailable } = readiness;
  return `
      <section class="property-section ocr-section">
        <h3>Local OCR &amp; layout</h3>
        ${ocrLanguages.length ? `<label class="field-label" for="ocr-language">Recognition language</label>
          <select id="ocr-language" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>
            ${ocrLanguages.map((language) => `<option value="${escapeHtml(language)}" ${language === state.ocrLanguage ? 'selected' : ''}>${escapeHtml(language)}</option>`).join('')}
          </select>
          <label class="field-label" for="ocr-cleanup-preset">Image cleanup</label>
          <select id="ocr-cleanup-preset" ${readiness.ready ? '' : 'disabled'}>
            ${[['none', 'None'], ['document', 'Deskew, despeckle & levels'], ['bilevel', 'Bilevel document']].map(([value, label]) => `<option value="${value}" ${state.ocrCleanupPreset === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <label class="field-label" for="ocr-segmentation">Page segmentation</label>
          <select id="ocr-segmentation" ${readiness.ready ? '' : 'disabled'}>
            ${[['auto', 'Automatic'], ['single-column', 'Single column'], ['block', 'Uniform text block'], ['sparse', 'Sparse text']].map(([value, label]) => `<option value="${value}" ${state.ocrSegmentation === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <label class="field-label" for="ocr-user-dictionary">Recognition dictionary</label>
          <textarea id="ocr-user-dictionary" rows="4" maxlength="16384" placeholder="One term per line" ${readiness.ready ? '' : 'disabled'}>${escapeHtml(state.ocrUserDictionary ?? '')}</textarea>
          <p class="field-help">Optional local terms, one per line. Terms are normalized; OCR results and artifact provenance reveal only a count and digest.</p>
          <button class="button" data-action="ocr-screenshot-capture" ${ocrCopyReady ? '' : 'disabled'}>${icon('search')}OCR from clipboard image</button>
          <p class="field-help">Captures a single screenshot from the clipboard as PNG, converts it to one-page PDF, then runs local OCR. The resulting searchable PDF is separate and the source PDF is unchanged.</p>
          <button class="button" data-action="create-ocr-copy" ${ocrCopyReady ? '' : 'disabled'}>${icon('search')}Create searchable OCR PDF</button>
          <p class="field-help">Creates a separate rasterized PDF with a local Tesseract text layer. Forms, links, signatures, vectors, layers, and tags are not preserved.${state.ocrCleanupPreset !== 'none' && !rasterAvailable ? ' The selected cleanup preset requires ImageMagick.' : ''}</p>
          ${ocrCopyResult(state)}
          <details class="ocr-layout-controls">
            <summary>Analyze full page or typed zones</summary>
            <label class="checkbox-control"><input id="ocr-detect-tables" type="checkbox" ${state.ocrDetectTables === false ? '' : 'checked'} ${ocrLayoutReady ? '' : 'disabled'} /> Detect table candidates</label>
            <label class="field-label" for="ocr-zone-select">Zones on page ${state.selectedPage ?? 1}</label>
            <select id="ocr-zone-select" ${ocrLayoutReady ? '' : 'disabled'}><option value="">No zone selected</option>${(state.ocrZones ?? []).filter((zone) => zone.page === (state.selectedPage ?? 1)).map((zone) => `<option value="${escapeHtml(zone.id)}" ${state.selectedOcrZoneId === zone.id ? 'selected' : ''}>${escapeHtml(zone.id)} · ${escapeHtml(zone.type)}</option>`).join('')}</select>
            ${ocrZoneEditor(state, ocrLayoutReady)}
            <div class="button-row">
              <button class="button" data-action="add-ocr-zone" ${ocrLayoutReady ? '' : 'disabled'}>Add zone</button>
              <button class="button" data-action="remove-ocr-zone" ${ocrLayoutReady && state.selectedOcrZoneId ? '' : 'disabled'}>Remove zone</button>
              <button class="button" data-action="analyze-ocr-page" ${ocrLayoutReady ? '' : 'disabled'}>Analyze page ${state.selectedPage ?? 1}</button>
            </div>
            <p class="field-help">No zones analyzes the full page. Zones are bounded, unique, non-overlapping local coordinates. Text and table zones are recognized; image and exclude zones produce classification-only records and are not sent to Tesseract. Exports require an explicit result selection.</p>
          </details>
          ${ocrLayoutResult(state)}`
          : '<p class="field-help">Tesseract is not available in the local engine registry.</p>'}
        <details class="ocr-layout-controls">
          <summary>Batch searchable OCR PDFs</summary>
          <input id="ocr-batch-picker" type="file" accept="application/pdf,.pdf" multiple ${ocrCopyReady ? '' : 'disabled'} />
          <p class="field-help">Choose 1 through 8 PDFs. They are uploaded only to this local host session and do not replace the open document. Artifacts are downloaded only when you select each download button.</p>
          <div role="status">${state.ocrBatchFiles?.length ? `${state.ocrBatchFiles.length} file${state.ocrBatchFiles.length === 1 ? '' : 's'} selected: ${state.ocrBatchFiles.map((file) => escapeHtml(file.name)).join(', ')}` : 'No batch PDFs selected.'}</div>
          <div class="button-row"><button class="button" data-action="run-ocr-batch" ${ocrCopyReady && state.ocrBatchFiles?.length ? '' : 'disabled'}>Run local OCR batch</button></div>
          ${ocrBatchResult(state)}
        </details>
      </section>`;
}
