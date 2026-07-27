import { escapeHtml } from './shared.js';

export function renderOcrCopyResult(state) {
  const result = state.ocrResult;
  if (!result) return '';
  const suspectCount = Array.isArray(result.suspects) ? result.suspects.length : 0;
  const recognizedWordCount = Number.isSafeInteger(result.recognizedWordCount) ? result.recognizedWordCount : 0;
  const pageCount = Number.isSafeInteger(result.pageCount) ? result.pageCount : 0;
  const userDictionaryTermCount = Number.isSafeInteger(result.userDictionary?.termCount) ? result.userDictionary.termCount : 0;
  const decisions = state.ocrSuspectReviewStates ?? [];
  const reviewed = decisions.filter((value) => value !== 'unreviewed').length;
  const rows = result.suspects.map((suspect, index) => {
    const decision = decisions[index] ?? 'unreviewed';
    const options = [
      ['unreviewed', 'Unreviewed'],
      ['confirmed-low-confidence', 'Confirmed low confidence'],
      ['false-positive', 'False positive'],
    ].map(([value, label]) => `<option value="${value}" ${decision === value ? 'selected' : ''}>${label}</option>`).join('');
    return `<tr><td>${index + 1}</td><td>${escapeHtml(suspect.page)}</td><td>${escapeHtml(suspect.text)}</td><td>${escapeHtml(suspect.confidence)}</td><td>${escapeHtml(`${suspect.left},${suspect.top} ${suspect.width}×${suspect.height}px`)}</td><td><label class="sr-only" for="ocr-suspect-${index}">Review state for suspect ${index + 1}</label><select id="ocr-suspect-${index}" class="ocr-suspect-review-state" data-ocr-suspect-index="${index}">${options}</select></td></tr>`;
  }).join('');
  const inventory = suspectCount
    ? `<div class="table-scroll"><table><thead><tr><th scope="col">#</th><th scope="col">Page</th><th scope="col">Recognized text</th><th scope="col">Confidence</th><th scope="col">OCR pixel geometry</th><th scope="col">Review state</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p>No low-confidence words were flagged by this OCR run.</p>';
  return `<div class="ocr-result"><p role="status"><strong>${suspectCount} suspect word${suspectCount === 1 ? '' : 's'}</strong><span>${recognizedWordCount} recognized · ${pageCount} page${pageCount === 1 ? '' : 's'} · ${escapeHtml(result.language ?? 'unknown')} · ${escapeHtml(result.cleanupPreset ?? 'none')} cleanup · ${userDictionaryTermCount} user dictionary term${userDictionaryTermCount === 1 ? '' : 's'}</span></p><details><summary>Review OCR suspects · ${reviewed}/${suspectCount} classified</summary>${inventory}<button class="button" data-action="export-ocr-suspect-review">Export suspect review JSON</button><p class="field-help">This session-only review classifies the existing OCR inventory. It does not correct recognized text, draw source-page boxes, change the searchable OCR PDF, or establish authoritative text.</p></details></div>`;
}

export function renderOcrBatchResult(state) {
  const batch = state.ocrBatchResult;
  if (!batch) return '';
  return `<div class="ocr-result" role="status"><strong>OCR batch ${escapeHtml(batch.manifest?.status ?? 'unknown')}</strong>${(batch.items ?? []).map((item) => `<div>${escapeHtml(item.name)} — ${escapeHtml(item.status)}${item.error ? `: ${escapeHtml(item.error.message)}` : ''} ${item.artifact ? `<button class="button" data-action="download-ocr-batch-artifact" data-ocr-batch-id="${item.id}">Download artifact</button>` : ''}</div>`).join('')}<div class="button-row"><button class="button" data-action="export-ocr-batch-manifest">Export manifest</button></div></div>`;
}

export function renderLoupeResult(state) {
  const loupe = state.loupeRaster ?? { status: 'idle' }; const page = state.selectedPage ?? 1;
  if (loupe.status === 'ready' && loupe.page === page && loupe.url) return `<figure class="loupe-view" aria-label="Magnified passive raster region for page ${page}"><img src="${escapeHtml(loupe.url)}" alt="Magnified CropBox raster region from page ${page}" draggable="false" /><figcaption>Page ${page} · fixed ${escapeHtml(loupe.dpi)} DPI · passive local PNG</figcaption></figure>`;
  if (loupe.status === 'loading' && loupe.page === page) return '<div class="loupe-state" role="status"><span class="spinner"></span><span>Rendering magnified raster region…</span></div>';
  if (loupe.status === 'error' && loupe.page === page) return `<div class="loupe-state" role="alert"><span>${escapeHtml(loupe.error ?? 'Local loupe rendering failed.')}</span></div>`;
  return '<div class="loupe-state" role="status">Refresh to inspect the selected normalized region.</div>';
}
