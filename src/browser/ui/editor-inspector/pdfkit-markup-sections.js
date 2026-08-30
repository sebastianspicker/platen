import { escapeHtml } from '../shared.js';
import { pdfkitOutlineSections } from './pdfkit-outline-sections.js';

export function pdfkitMarkupSections(state, context) {
  const {
    pdfkitLineReady,
    pdfkitInkReady,
    pdfkitLocalLinkReady,
    incrementalGoToLinkReady,
    localLinkEditorReady,
    localLinkPageCount,
    pdfkitLocalLinkRemovalCandidates,
    pdfkitLocalLinkRemovalReady,
  } = context;
  return `
        <details>
          <summary>Straight-line markup on selected page</summary>
          <p class="field-help">Both endpoints must lie inside page ${escapeHtml(state.selectedPage ?? 1)}’s inspected CropBox. The helper computes the annotation bounds and fixes both line endings to None.</p>
          <label class="field-label" for="pdfkit-line-contents">Private line contents</label>
          <textarea id="pdfkit-line-contents" maxlength="1024" rows="2" ${pdfkitLineReady ? '' : 'disabled'}>${escapeHtml(state.pdfkitLineContents ?? '')}</textarea>
          <div class="numeric-grid" aria-label="Line endpoints in PDF points">
            <label>Start X <input id="pdfkit-line-start-x" type="number" step="0.1" value="${escapeHtml(state.pdfkitLineStart?.x ?? 72)}" ${pdfkitLineReady ? '' : 'disabled'} /></label>
            <label>Start Y <input id="pdfkit-line-start-y" type="number" step="0.1" value="${escapeHtml(state.pdfkitLineStart?.y ?? 72)}" ${pdfkitLineReady ? '' : 'disabled'} /></label>
            <label>End X <input id="pdfkit-line-end-x" type="number" step="0.1" value="${escapeHtml(state.pdfkitLineEnd?.x ?? 252)}" ${pdfkitLineReady ? '' : 'disabled'} /></label>
            <label>End Y <input id="pdfkit-line-end-y" type="number" step="0.1" value="${escapeHtml(state.pdfkitLineEnd?.y ?? 152)}" ${pdfkitLineReady ? '' : 'disabled'} /></label>
          </div>
          <button class="button primary" data-action="create-pdfkit-line-annotation-copy" ${pdfkitLineReady ? '' : 'disabled'}>Create lined PDF</button>
          <p class="field-help">This source-bound profile adds exactly one embedded <code>/Line</code> annotation, verifies its reopened endpoints and fixed styles, and omits contents and coordinates from its receipt. Signed, encrypted, form-bearing, action/media/attachment-bearing, and automatic-presentation inputs fail closed.</p>
        </details>
        <details>
          <summary>Open ink path on selected page</summary>
          <p class="field-help">Enter 2 through 32 <code>x,y</code> points separated by semicolons. Every point must lie inside page ${escapeHtml(state.selectedPage ?? 1)}’s inspected CropBox; the helper derives bounds and keeps the single stroke open.</p>
          <label class="field-label" for="pdfkit-ink-contents">Private ink contents</label>
          <textarea id="pdfkit-ink-contents" maxlength="1024" rows="2" ${pdfkitInkReady ? '' : 'disabled'}>${escapeHtml(state.pdfkitInkContents ?? '')}</textarea>
          <label class="field-label" for="pdfkit-ink-points">Path points in PDF coordinates</label>
          <textarea id="pdfkit-ink-points" maxlength="1024" rows="3" spellcheck="false" ${pdfkitInkReady ? '' : 'disabled'}>${escapeHtml(state.pdfkitInkPoints ?? '')}</textarea>
          <button class="button primary" data-action="create-pdfkit-ink-annotation-copy" ${pdfkitInkReady ? '' : 'disabled'}>Create inked PDF</button>
          <p class="field-help">This source-bound profile adds exactly one embedded <code>/Ink</code> annotation with one fixed open path, verifies its reopened geometry and raw <code>/InkList</code>, and omits contents and coordinates from its receipt. It accepts no style, action, popup, attachment, author, or arbitrary object controls. Signed, encrypted, form-bearing, action/media/attachment-bearing, and automatic-presentation inputs fail closed.</p>
        </details>
        ${pdfkitOutlineSections(state, context)}
        <details>
          <summary>Local page link on selected page</summary>
          <p class="field-help">Source page ${escapeHtml(state.selectedPage ?? 1)}. The clickable rectangle must fit its inspected CropBox.</p>
          <label class="field-label" for="pdfkit-link-target-page">Target page</label>
          <select id="pdfkit-link-target-page" ${localLinkEditorReady ? '' : 'disabled'}>
            ${Array.from({ length: localLinkPageCount }, (_, index) => index + 1).map((page) => `<option value="${page}" ${String(page) === String(state.pdfkitLinkTargetPage) ? 'selected' : ''}>Page ${page}</option>`).join('')}
          </select>
          <div class="numeric-grid" aria-label="Local link rectangle in PDF points">
            <label>X <input id="pdfkit-link-x" type="number" step="1" value="${escapeHtml(state.pdfkitLinkRect?.x ?? 36)}" ${localLinkEditorReady ? '' : 'disabled'} /></label>
            <label>Y <input id="pdfkit-link-y" type="number" step="1" value="${escapeHtml(state.pdfkitLinkRect?.y ?? 36)}" ${localLinkEditorReady ? '' : 'disabled'} /></label>
            <label>Width <input id="pdfkit-link-width" type="number" min="1" step="1" value="${escapeHtml(state.pdfkitLinkRect?.width ?? 180)}" ${localLinkEditorReady ? '' : 'disabled'} /></label>
            <label>Height <input id="pdfkit-link-height" type="number" min="1" step="1" value="${escapeHtml(state.pdfkitLinkRect?.height ?? 40)}" ${localLinkEditorReady ? '' : 'disabled'} /></label>
          </div>
          <button class="button primary" data-action="create-incremental-goto-link-copy" ${incrementalGoToLinkReady ? '' : 'disabled'}>Create object-preserving linked PDF</button>
          <p class="field-help">The cross-platform path adds one direct <code>/Dest /Fit</code> link through a classic appended revision and keeps the exact source prefix. It requires explicit integer MediaBox/CropBox geometry, a passive annotation subset with no existing links, and no active content or signatures. Raw reinspection, Poppler text/box checks, and fixed 256-pixel all-page render equality apply.</p>
          <button class="button" data-action="create-pdfkit-local-goto-copy" ${pdfkitLocalLinkReady ? '' : 'disabled'}>Create PDFKit linked fallback</button>
          <p class="field-help">The macOS fallback writes both an intra-document <code>/Dest</code> and PDFKit’s redundant <code>/A /GoTo</code> to the same existing page. URI, remote-file, named, launch, submit, JavaScript, additional actions, forms, signatures, and unsafe source action graphs fail closed. The helper verifies the raw destination and the reopened link; PDFKit may rewrite unrelated object serialization.</p>
        </details>
        <details>
          <summary>Remove one exact local page link</summary>
          <label class="field-label" for="pdfkit-local-link-removal-index">Fully inspected local-link candidate on selected page</label>
          <select id="pdfkit-local-link-removal-index" ${pdfkitLocalLinkRemovalReady ? '' : 'disabled'}>
            ${pdfkitLocalLinkRemovalCandidates.length ? pdfkitLocalLinkRemovalCandidates.map((link) => `<option value="${link.annotationIndex}" ${String(link.annotationIndex) === String(state.pdfkitLocalLinkRemovalIndex) ? 'selected' : ''}>Page ${escapeHtml(state.selectedPage ?? 1)} annotation ${link.annotationIndex} → page ${link.targetPage}</option>`).join('') : '<option value="">No fully inventoried local links on this page</option>'}
          </select>
          <button class="button danger-button" data-action="remove-pdfkit-local-goto-link" ${pdfkitLocalLinkRemovalReady ? '' : 'disabled'}>Create verified link-removal copy</button>
          <p class="field-help">The helper revalidates the opaque exact-source locator and accepts only the strict dual direct-<code>/Dest</code> plus <code>/A /GoTo /D</code> shape produced by this app. Other local-link candidates fail closed. Candidate and private-file reopen checks require exactly that annotation occurrence to disappear while every remaining ordered passive annotation descriptor, page box, and rotation stays unchanged. This is not hidden-object scrubbing, prior-revision removal, or byte/object preservation.</p>
        </details>`;
}
