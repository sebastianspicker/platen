import { escapeHtml } from '../shared.js';

export function pdfkitOutlineSections(state, context) {
  const {
    pdfkitOutlineReady,
    pdfkitOutlineRemovalCandidates,
    pdfkitOutlineRemovalReady,
    pdfkitOutlineRenameCandidates,
    pdfkitOutlineRenameReady,
    pdfkitPageCount,
  } = context;
  return `<details>
          <summary>Top-level local bookmark</summary>
          <p class="field-help">Append one direct bookmark to an existing page’s inspected CropBox top-left. Labels are NFC-normalized, bounded to 1,024 UTF-8 bytes, and cannot contain control or format characters.</p>
          <label class="field-label" for="pdfkit-outline-label">Bookmark label</label>
          <input id="pdfkit-outline-label" type="text" maxlength="1024" value="${escapeHtml(state.pdfkitOutlineLabel ?? '')}" ${pdfkitOutlineReady ? '' : 'disabled'} />
          <label class="field-label" for="pdfkit-outline-target-page">Target page</label>
          <select id="pdfkit-outline-target-page" ${pdfkitOutlineReady ? '' : 'disabled'}>
            ${Array.from({ length: pdfkitPageCount }, (_, index) => index + 1).map((page) => `<option value="${page}" ${String(page) === String(state.pdfkitOutlineTargetPage) ? 'selected' : ''}>Page ${page}</option>`).join('')}
          </select>
          <button class="button primary" data-action="create-pdfkit-outline-copy" ${pdfkitOutlineReady ? '' : 'disabled'}>Create bookmarked PDF</button>
          <p class="field-help">The pinned helper verifies the exact source, prior direct-destination outline hierarchy, all page boxes and rotations, passive annotations, one raw direct destination, and a private reopen. Sources with GoTo-action outlines fail closed because PDFKit would normalize their representation. No named, remote, launch, script, coordinate, nesting, or replacement controls are accepted.</p>
        </details>
        <details>
          <summary>Rename one exact top-level leaf bookmark</summary>
          <label class="field-label" for="pdfkit-outline-rename-index">Fully inspected direct-destination candidate</label>
          <select id="pdfkit-outline-rename-index" ${pdfkitOutlineRenameCandidates.length ? '' : 'disabled'}>
            ${pdfkitOutlineRenameCandidates.length ? pdfkitOutlineRenameCandidates.map((item) => `<option value="${item.topLevelIndex}" ${String(item.topLevelIndex) === String(state.pdfkitOutlineRenameIndex) ? 'selected' : ''}>Bookmark ${item.topLevelIndex + 1}${item.title ? ` · ${escapeHtml(item.title)}` : ''}${item.page ? ` · page ${item.page}` : ''}</option>`).join('') : '<option value="">No renameable fully inspected leaf bookmarks</option>'}
          </select>
          <label class="field-label" for="pdfkit-outline-rename-label">New bookmark label</label>
          <input id="pdfkit-outline-rename-label" type="text" maxlength="1024" value="${escapeHtml(state.pdfkitOutlineRenameLabel ?? '')}" ${pdfkitOutlineRenameCandidates.length ? '' : 'disabled'} />
          <button class="button primary" data-action="rename-pdfkit-outline-bookmark" ${pdfkitOutlineRenameReady ? '' : 'disabled'}>Create verified bookmark-rename copy</button>
          <p class="field-help">Only a fully inspected top-level leaf with a complete raw direct destination and opaque exact-source locator is eligible. The helper changes only its decoded NFC title and proves the same destination, position, outline hierarchy, page geometry, annotations, extracted text, and fixed renders after private-file reopen. Old and new labels, destination coordinates, and the locator never enter the receipt. No-op, nested, action-based, signed, encrypted, form-bearing, tagged, layered, page-label, XMP, custom-Info, or otherwise unsupported sources fail closed.</p>
        </details>
        <details>
          <summary>Remove one exact top-level leaf bookmark</summary>
          <label class="field-label" for="pdfkit-outline-removal-index">Fully inspected direct-destination candidate</label>
          <select id="pdfkit-outline-removal-index" ${pdfkitOutlineRemovalReady ? '' : 'disabled'}>
            ${pdfkitOutlineRemovalCandidates.length ? pdfkitOutlineRemovalCandidates.map((item) => `<option value="${item.topLevelIndex}" ${String(item.topLevelIndex) === String(state.pdfkitOutlineRemovalIndex) ? 'selected' : ''}>Bookmark ${item.topLevelIndex + 1}${item.title ? ` · ${escapeHtml(item.title)}` : ''}${item.page ? ` · page ${item.page}` : ''}</option>`).join('') : '<option value="">No removable fully inspected leaf bookmarks</option>'}
          </select>
          <button class="button danger-button" data-action="remove-pdfkit-outline-bookmark" ${pdfkitOutlineRemovalReady ? '' : 'disabled'}>Create verified bookmark-removal copy</button>
          <p class="field-help">Only a top-level leaf with a complete raw direct <code>/Dest [page /XYZ x y null]</code> and an opaque exact-source locator is eligible. The helper removes exactly that node, then compares every remaining outline node, page box, rotation, ordered annotation descriptor, extracted-text hash, fixed render hash, and bounded standard Info metadata before and after a private-file reopen. Labels, destinations, coordinates, and locators never enter the receipt. Nested, truncated, action-based, named, remote, signed, encrypted, form-bearing, page-label, tagged, layered, XMP, custom-Info, name-tree, viewer-preference, or non-passive page sources fail closed.</p>
        </details>`;
}
