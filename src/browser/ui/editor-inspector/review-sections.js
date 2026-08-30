import {
  accessibilityReviewResult,
  incrementalAccessibilityMetadataResult,
  prepressResult,
  standardsValidationResult,
} from '../editor-result-views.js';
import { escapeHtml } from '../shared.js';

export function reviewSections(state, {
  ready,
  ghostscriptAvailable,
  rasterAvailable,
  incrementalAccessibilityMetadataReady,
  incrementalAccessibilityMetadataEditorReady,
  accessibilityAltTextReady,
  accessibilityAltTextEditorReady,
}) {
  const outputIntentReady = ready
    && Boolean(state.analysis?.documentId)
    && state.host?.prepressReady === true
    && ghostscriptAvailable
    && state.host?.outputIntentProfileReady === true;
  return `
      <section class="property-section prepress-section">
        <h3>Local prepress review</h3>
        <label class="field-label" for="preflight-profile">Fixed review profile</label>
        <select id="preflight-profile" ${ready ? '' : 'disabled'}>
          <option value="print-review" ${state.preflightProfile === 'print-review' ? 'selected' : ''}>Print review</option>
          <option value="archive-review" ${state.preflightProfile === 'archive-review' ? 'selected' : ''}>Archive review</option>
        </select>
        <button class="button" data-action="prepress-run-profile" ${ready ? '' : 'disabled'}>Run fixed preflight review</button>
        <label class="field-label" for="prepress-dpi">Preview DPI</label>
        <input id="prepress-dpi" type="number" min="36" max="300" step="1" value="${escapeHtml(state.prepressDpi ?? 144)}" ${ready ? '' : 'disabled'} />
        <div class="page-transform-grid" role="group" aria-label="Local prepress review operations">
          <button class="button" data-action="prepress-ink-coverage" ${ready && ghostscriptAvailable ? '' : 'disabled'}>Ink coverage</button>
          <button class="button" data-action="prepress-separations" ${ready && ghostscriptAvailable && rasterAvailable ? '' : 'disabled'}>Separations</button>
          <button class="button" data-action="prepress-overprint" ${ready && ghostscriptAvailable ? '' : 'disabled'}>Overprint preview</button>
        </div>
        <div class="prepress-production-controls" role="group" aria-label="Local prepress output operations">
          <button class="button" data-action="prepress-convert-cmyk" ${ready && ghostscriptAvailable ? '' : 'disabled'}>Create fixed-profile CMYK copy</button>
          <button class="button" data-action="prepress-assign-output-intent" ${outputIntentReady ? '' : 'disabled'}>Create OutputIntent PDF</button>
          <label class="checkbox-label"><input id="imposition-marks" type="checkbox" disabled /> Production marks unavailable</label>
          <button class="button" data-action="prepress-impose-2up" ${ready && ghostscriptAvailable ? '' : 'disabled'}>Create 2-up PDF</button>
          <button class="button" data-action="prepress-impose-4up" ${ready && ghostscriptAvailable ? '' : 'disabled'}>Create 4-up PDF</button>
          <button class="button" data-action="prepress-production-validation" ${ready && ghostscriptAvailable ? '' : 'disabled'}>Run production validation</button>
        </div>
        <p class="field-help">Ghostscript and ImageMagick produce bounded local review evidence and derived files. Fixed-profile CMYK conversion does not assign an OutputIntent. The OutputIntent action downloads a separate derived PDF with the fixed host profile; it does not establish PDF/X conformance, colorimetric conformance, press certification, or production-RIP parity. N-up supports fixed row-major layouts only; validated printer marks are unavailable.</p>
        ${prepressResult(state)}
      </section>
      <section class="property-section standards-section">
        <h3>Authoritative standards validation</h3>
        <label class="field-label" for="standards-profile">Fixed profile</label>
        <select id="standards-profile" ${ready ? '' : 'disabled'}>
          ${[
            ['pdfa-1a', 'PDF/A-1a'], ['pdfa-1b', 'PDF/A-1b'],
            ['pdfa-2a', 'PDF/A-2a'], ['pdfa-2b', 'PDF/A-2b'], ['pdfa-2u', 'PDF/A-2u'],
            ['pdfa-3a', 'PDF/A-3a'], ['pdfa-3b', 'PDF/A-3b'], ['pdfa-3u', 'PDF/A-3u'],
            ['pdfa-4', 'PDF/A-4'], ['pdfa-4e', 'PDF/A-4e'], ['pdfa-4f', 'PDF/A-4f'],
            ['pdfua-1', 'PDF/UA-1'], ['pdfua-2', 'PDF/UA-2'], ['pdfx', 'PDF/X — unavailable'],
          ].map(([value, label]) => `<option value="${value}" ${state.standardsProfile === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="button" data-action="run-standards-validation" ${ready && state.host?.standardsValidationReady ? '' : 'disabled'}>Validate exact profile</button>
        <p class="field-help">Requires a transitively hash-pinned local veraPDF 1.30.1 bundle. No PATH fallback or custom profile is accepted. PDF/X remains unavailable because veraPDF does not validate it.${state.host?.standardsValidationReady ? '' : ' No trusted validator bundle is currently staged.'}</p>
        ${standardsValidationResult(state)}
      </section>
      <section class="property-section accessibility-section">
        <h3>Local accessibility review</h3>
        <button class="button" data-action="run-accessibility-review" ${ready ? '' : 'disabled'}>Run fixed basic review</button>
        <p class="field-help">Checks bounded local tag-role shape, title, language, font embedding/Unicode, readable-text, and—when the isolated PDFKit helper is staged—assistive-access permission evidence. It emits source-bound proposal-only remediation candidates. Reading order, alternative-text meaning, form semantics, contrast, and PDF/UA conformance remain explicitly unproven.</p>
        ${accessibilityReviewResult(state, {
    accessibilityAltTextReady,
    accessibilityAltTextEditorReady,
  })}
        <h4>Document language and title copy</h4>
        <label class="field-label" for="accessibility-document-language">Document default language</label>
        <input id="accessibility-document-language" type="text" maxlength="35" autocomplete="off" value="${escapeHtml(state.accessibilityDocumentLanguage ?? '')}" ${incrementalAccessibilityMetadataEditorReady ? '' : 'disabled'} />
        <label class="field-label" for="accessibility-document-title">Info title</label>
        <input id="accessibility-document-title" type="text" maxlength="256" autocomplete="off" value="${escapeHtml(state.accessibilityDocumentTitle ?? '')}" ${incrementalAccessibilityMetadataEditorReady ? '' : 'disabled'} />
        <button class="button" data-action="create-accessibility-language-title-copy" ${incrementalAccessibilityMetadataReady ? '' : 'disabled'}>Create language and title copy</button>
        <p class="field-help">Available only after the current source-bound review reports both values missing. The separate append-only copy adds Catalog /Lang and Info /Title only. Prior metadata remains recoverable; this is not content-item language, tagging, structure repair, PDF/UA or WCAG conformance, sanitization, or signature preservation.</p>
        ${incrementalAccessibilityMetadataResult(state)}
      </section>`;
}
