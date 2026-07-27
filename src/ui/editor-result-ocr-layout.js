import { escapeHtml } from './shared.js';

export function ocrLayoutResult(state) {
  const result = state.ocrLayoutResult;
  if (!result) return '';
  const records = Array.isArray(result.records) ? result.records.slice(0, 32) : [];
  const words = records.flatMap(
    (record) => (Array.isArray(record?.layout?.words) ? record.layout.words : []),
  );
  const tableCandidates = records.flatMap(
    (record) => (Array.isArray(record?.tableCandidates) ? record.tableCandidates : []),
  );
  const previewWords = words.slice(0, 12)
    .map((word) => `<span class="ocr-word-chip" title="Confidence ${escapeHtml(word?.confidence ?? '—')}">${escapeHtml(String(word?.text ?? '').slice(0, 80))}</span>`)
    .join('');
  const bestTableAlignment = tableCandidates.reduce(
    (best, candidate) => Math.max(best, Number(candidate?.alignmentScore) || 0),
    0,
  );
  const truncatedTableCount = tableCandidates.filter(
    (candidate) => candidate?.truncated === true,
  ).length;
  const selectedRecord = records[state.selectedOcrRecordIndex];
  const selectedCandidate = selectedRecord?.tableCandidates?.[state.selectedOcrTableCandidate];
  const altoAvailable = selectedRecord?.alto?.mediaType === 'application/alto+xml'
    && selectedRecord.alto.encoding === 'base64';
  const tableCsvAvailable = Array.isArray(selectedCandidate?.grid)
    && selectedCandidate.grid.length >= 2;
  const limitations = Array.isArray(result.limitations) ? result.limitations.slice(0, 2) : [];
  return `<div class="comparison-result ocr-layout-result" role="status">
    <strong>OCR layout evidence ready</strong>
    <span>${words.length} recognized word${words.length === 1 ? '' : 's'} in ${records.length} region${records.length === 1 ? '' : 's'} · ${escapeHtml(result.language ?? 'unknown')}</span>
    <span>${tableCandidates.length} geometry-based table candidate${tableCandidates.length === 1 ? '' : 's'}${tableCandidates.length ? ` · best alignment score ${(bestTableAlignment * 100).toFixed(1)}%` : ''}${truncatedTableCount ? ` · ${truncatedTableCount} bounded/truncated` : ''}. ${result.detectTables ? 'Every candidate requires human review.' : 'Table detection was disabled.'}</span>
    ${previewWords ? `<div class="ocr-word-preview" aria-label="Recognized word sample">${previewWords}</div>` : '<span>No words were recognized in this region.</span>'}
    ${limitations.map((limitation) => `<span>${escapeHtml(limitation)}</span>`).join('')}
    <label class="field-label" for="ocr-result-record">Result record</label>
    <select id="ocr-result-record">
      <option value="">Select a record before ALTO or CSV export</option>
      ${records.map((record, index) => `<option value="${index}" ${state.selectedOcrRecordIndex === index ? 'selected' : ''}>Page ${escapeHtml(record?.page ?? '?')} · ${escapeHtml(record?.zoneId ?? 'full page')} · ${escapeHtml(record?.recognizedWordCount ?? 0)} words</option>`).join('')}
    </select>
    <label class="field-label" for="ocr-table-candidate">Table candidate</label>
    <select id="ocr-table-candidate" ${selectedRecord ? '' : 'disabled'}>
      <option value="">Select a table candidate before CSV export</option>
      ${(selectedRecord?.tableCandidates ?? []).map((candidate, index) => `<option value="${index}" ${state.selectedOcrTableCandidate === index ? 'selected' : ''}>Candidate ${index + 1} · ${((Number(candidate?.alignmentScore) || 0) * 100).toFixed(1)}%</option>`).join('')}
    </select>
    <div class="button-row" aria-label="OCR layout exports">
      <button class="button" data-action="export-ocr-layout-json">JSON</button>
      <button class="button" data-action="export-ocr-layout-html">Review HTML</button>
      <button class="button" data-action="export-ocr-layout-alto" ${altoAvailable ? '' : 'disabled'}>ALTO XML</button>
      <button class="button" data-action="export-ocr-table-csv" ${tableCsvAvailable ? '' : 'disabled'}>Table CSV</button>
    </div>
    <span>Table CSV is derived from OCR geometry, neutralizes spreadsheet formula prefixes, and always requires human review.</span>
  </div>`;
}
