import { escapeHtml } from '../shared.js';

function metadataAndBoxSections(state, context) {
  const {
    incrementalBleedBoxReady, incrementalMetadataReady, pdfkitLegacyReady,
    incrementalNamedDestinationEditorReady, incrementalNamedDestinationPageCount,
    incrementalNamedDestinationReady,
    incrementalPageVectorReady, incrementalPageVectorEditorReady,
    pageTextReady, pageTextEditorReady,
    pdfkitPageBoxEditorReady, pdfkitPageBoxReady, pdfkitRotationReady,
    pdfkitCurrentRotation,
  } = context;
  const metadataReady = incrementalMetadataReady || pdfkitLegacyReady;
  return `
        <details>
          <summary>Standard metadata</summary>
          <label class="field-label" for="pdfkit-title">Title; empty removes it</label>
          <input id="pdfkit-title" maxlength="1024" value="${escapeHtml(state.pdfkitMetadata?.title ?? '')}" ${metadataReady ? '' : 'disabled'} />
          <label class="field-label" for="pdfkit-author">Author; empty removes it</label>
          <input id="pdfkit-author" maxlength="1024" value="${escapeHtml(state.pdfkitMetadata?.author ?? '')}" ${metadataReady ? '' : 'disabled'} />
          <label class="field-label" for="pdfkit-subject">Subject; empty removes it</label>
          <input id="pdfkit-subject" maxlength="1024" value="${escapeHtml(state.pdfkitMetadata?.subject ?? '')}" ${metadataReady ? '' : 'disabled'} />
          <label class="field-label" for="pdfkit-keywords">Keywords; empty removes them</label>
          <input id="pdfkit-keywords" maxlength="1024" value="${escapeHtml(state.pdfkitMetadata?.keywords ?? '')}" ${metadataReady ? '' : 'disabled'} />
          <button class="button primary" data-action="create-incremental-metadata-copy" ${incrementalMetadataReady ? '' : 'disabled'}>Create object-preserving PDF</button>
          <p class="field-help">The local classic-xref profile appends one fresh Info object and revision while preserving the source as the exact byte prefix. Historical metadata therefore remains recoverable: this is editing, not sanitization or privacy removal. Signed, encrypted, XMP-bearing, form, JavaScript, attachment, URL, xref-stream, object-stream, malformed, and unsupported inputs fail closed.</p>
          <button class="button" data-action="create-pdfkit-metadata-copy" ${pdfkitLegacyReady ? '' : 'disabled'}>Create PDFKit-derived fallback</button>
          <p class="field-help">The macOS fallback supports a different bounded source subset but rewrites object serialization and is not byte preserving.</p>
        </details>
        <details>
          <summary>Named destination</summary>
          <label class="field-label" for="incremental-named-destination-name">Destination name</label>
          <input id="incremental-named-destination-name" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" value="${escapeHtml(state.incrementalNamedDestinationName ?? '')}" ${incrementalNamedDestinationEditorReady ? '' : 'disabled'} />
          <label class="field-label" for="incremental-named-destination-target-page">Target page</label>
          <select id="incremental-named-destination-target-page" ${incrementalNamedDestinationEditorReady ? '' : 'disabled'}>
            ${Array.from({ length: incrementalNamedDestinationPageCount }, (_, index) => index + 1).map((page) => `<option value="${page}" ${String(page) === String(state.incrementalNamedDestinationTargetPage) ? 'selected' : ''}>${page}</option>`).join('')}
          </select>
          <button class="button primary" data-action="create-incremental-named-destination-copy" ${incrementalNamedDestinationReady ? '' : 'disabled'}>Create object-preserving named destination PDF</button>
          <p class="field-help">The fixed cross-platform profile appends one direct name-tree entry whose target is an existing page with fixed <code>/Fit</code> view. Public inspection only provides a coarse candidate gate; the host reparses the raw graph and may reject it. Existing name trees or legacy destinations, any page annotations, actions, forms, signatures, active content, and unsupported graphs fail closed. The name is stored in the output PDF but omitted from receipts and provenance, which retain only its digest. Every source byte remains as the exact prefix, so this is not general destination management, sanitization, or signature preservation.</p>
        </details>
        <details>
          <summary>Selected-page box</summary>
          <label class="field-label" for="pdfkit-page-box">Box</label>
          <select id="pdfkit-page-box" ${pdfkitPageBoxEditorReady ? '' : 'disabled'}>
            ${[['media', 'MediaBox'], ['crop', 'CropBox'], ['bleed', 'BleedBox'], ['trim', 'TrimBox'], ['art', 'ArtBox']].map(([value, label]) => `<option value="${value}" ${state.pdfkitPageBox === value ? 'selected' : ''} ${pdfkitLegacyReady || value === 'bleed' ? '' : 'disabled'}>${label}</option>`).join('')}
          </select>
          <div class="numeric-grid" aria-label="Page-box rectangle in PDF points">
            <label>X <input id="pdfkit-box-x" type="number" step="0.1" value="${escapeHtml(state.pdfkitPageBoxRect?.x ?? 0)}" ${pdfkitPageBoxEditorReady ? '' : 'disabled'} /></label>
            <label>Y <input id="pdfkit-box-y" type="number" step="0.1" value="${escapeHtml(state.pdfkitPageBoxRect?.y ?? 0)}" ${pdfkitPageBoxEditorReady ? '' : 'disabled'} /></label>
            <label>Width <input id="pdfkit-box-width" type="number" min="0.1" step="0.1" value="${escapeHtml(state.pdfkitPageBoxRect?.width ?? 612)}" ${pdfkitPageBoxEditorReady ? '' : 'disabled'} /></label>
        <label>Height <input id="pdfkit-box-height" type="number" min="0.1" step="0.1" value="${escapeHtml(state.pdfkitPageBoxRect?.height ?? 792)}" ${pdfkitPageBoxEditorReady ? '' : 'disabled'} /></label>
          </div>
          <button class="button primary" data-action="create-incremental-bleed-box-copy" ${incrementalBleedBoxReady ? '' : 'disabled'}>Create object-preserving BleedBox PDF</button>
          <p class="field-help">The local cross-platform classic-xref profile accepts integer coordinates and one page whose MediaBox, TrimBox, and BleedBox are explicit direct arrays. It appends one replacement revision of that same page object, changes only BleedBox, and preserves the exact source as the output byte prefix. The requested box must stay inside MediaBox, contain the unchanged TrimBox, and differ from the source BleedBox. Independent raw reinspection, Poppler page/text/box checks, and matching fixed 256-pixel-long-edge validation renders apply; equality at other resolutions or in other renderers is not claimed.</p>
          <button class="button" data-action="create-pdfkit-pagebox-copy" ${pdfkitPageBoxReady ? '' : 'disabled'}>${state.pdfkitPageBox === 'crop' ? 'Create PDFKit cropped fallback' : state.pdfkitPageBox === 'bleed' ? 'Create PDFKit BleedBox fallback' : 'Create PDFKit-derived PDF'}</button>
          <p class="field-help">The macOS PDFKit fallback supports resolved CropBox and BleedBox geometry, including inherited values, but rewrites object serialization. Its native candidate and reopened file preserve every other resolved page box and rotation plus a bounded annotation subtype, geometry, flags, contents digest. Private contents and descriptor hashes never leave the helper. Poppler independently confirms the exact output box and renders every page. Expanding the CropBox can reveal source content that was previously cropped from view. BleedBox must also contain the unchanged TrimBox. Signed, encrypted, form-bearing, JavaScript-bearing, unsupported, and no-op inputs fail closed. Explicit-versus-inherited box syntax is not preserved. Byte identity and unsupported structures are not preserved.</p>
        </details>`;
}

function overlaySections(state, context) {
  const {
    incrementalPageVectorReady, incrementalPageVectorEditorReady,
    pageTextReady, pageTextEditorReady,
  } = context;
  return `
        <details>
          <summary>Page-vector overlay</summary>
          <p class="field-help">Page ${escapeHtml(state.selectedPage ?? 1)}.</p>
          <div class="numeric-grid" aria-label="Page-vector rectangle in PDF points">
            <label>X <input id="incremental-page-vector-x" type="number" step="0.1" value="${escapeHtml(state.incrementalPageVectorRect?.x ?? 36)}" ${incrementalPageVectorEditorReady ? '' : 'disabled'} /></label>
            <label>Y <input id="incremental-page-vector-y" type="number" step="0.1" value="${escapeHtml(state.incrementalPageVectorRect?.y ?? 36)}" ${incrementalPageVectorEditorReady ? '' : 'disabled'} /></label>
            <label>Width <input id="incremental-page-vector-width" type="number" min="0.1" step="0.1" value="${escapeHtml(state.incrementalPageVectorRect?.width ?? 120)}" ${incrementalPageVectorEditorReady ? '' : 'disabled'} /></label>
            <label>Height <input id="incremental-page-vector-height" type="number" min="0.1" step="0.1" value="${escapeHtml(state.incrementalPageVectorRect?.height ?? 120)}" ${incrementalPageVectorEditorReady ? '' : 'disabled'} /></label>
          </div>
          <button class="button primary" data-action="create-incremental-page-vector-copy" ${incrementalPageVectorReady ? '' : 'disabled'}>Create object-preserving page-vector PDF</button>
          <p class="field-help">The local classic-xref profile appends one black 1pt stroked rectangle to the selected page and rewrites no other page content in a source-bound revision. It preserves the exact source bytes as output prefix and independently requires bounded page geometry and render checks where the selected target page changes and all other pages remain identical. This is not general vector editing, redaction, or signature-safe rewriting.</p>
        </details>
        <details>
          <summary>Page text run</summary>
          <p class="field-help">Page ${escapeHtml(state.selectedPage ?? 1)}. The selected page must be content-empty and have no resources; the host reparses the raw graph and may reject the public candidate gate.</p>
          <label class="field-label" for="page-text-value">Printable ASCII text</label>
          <textarea id="page-text-value" maxlength="512" rows="3" ${pageTextEditorReady ? '' : 'disabled'}>${escapeHtml(state.pageTextRun?.text ?? '')}</textarea>
          <div class="numeric-grid" aria-label="Page text baseline and size in PDF points">
            <label>X <input id="page-text-x" type="number" step="1" value="${escapeHtml(state.pageTextRun?.x ?? 36)}" ${pageTextEditorReady ? '' : 'disabled'} /></label>
            <label>Y <input id="page-text-y" type="number" step="1" value="${escapeHtml(state.pageTextRun?.y ?? 36)}" ${pageTextEditorReady ? '' : 'disabled'} /></label>
            <label>Size <input id="page-text-size" type="number" min="6" max="72" step="1" value="${escapeHtml(state.pageTextRun?.size ?? 12)}" ${pageTextEditorReady ? '' : 'disabled'} /></label>
          </div>
          <button class="button primary" data-action="create-page-text-copy" ${pageTextReady ? '' : 'disabled'}>Create append-only page-text PDF</button>
          <p class="field-help">Printable ASCII only, up to 512 bytes. The fixed profile appends one black Helvetica text run to a content-empty page with no resources. Every source byte remains as the exact output prefix, so historical bytes are retained. This is not general text editing, redaction, sanitization, conformance validation, or signature-safe rewriting.</p>
        </details>`;
}

function pdfKitFallbackSections(state, context) {
  const {
    pdfkitLegacyReady, pdfkitRotationReady, pdfkitCurrentRotation,
  } = context;
  return `
        <details>
          <summary>Persistent selected-page rotation</summary>
          <p class="field-help">Page ${escapeHtml(state.selectedPage ?? 1)} currently reports ${pdfkitCurrentRotation === null ? 'an unsupported rotation' : `${pdfkitCurrentRotation}°`}. Choose an absolute orientation for a separate non-rasterized PDF.</p>
          <label class="field-label" for="pdfkit-page-rotation">Absolute page rotation</label>
          <select id="pdfkit-page-rotation" ${pdfkitLegacyReady ? '' : 'disabled'}>
            ${[0, 90, 180, 270].map((degrees) => `<option value="${degrees}" ${String(degrees) === String(state.pdfkitPageRotation) ? 'selected' : ''}>${degrees}°</option>`).join('')}
          </select>
          <button class="button primary" data-action="create-pdfkit-rotation-copy" ${pdfkitRotationReady ? '' : 'disabled'}>Create rotated PDF</button>
          <p class="field-help">The native candidate and reopened file must contain the exact requested rotation while every other page rotation, all page boxes, and annotation inventories remain unchanged. Poppler independently confirms the output rotation and renders every page. Signed, encrypted, form-bearing, JavaScript-bearing, unsupported, and no-op inputs fail closed.</p>
        </details>
        <details>
          <summary>Non-action-bearing annotation on selected page</summary>
          <label class="field-label" for="pdfkit-annotation-subtype">Annotation type</label>
          <select id="pdfkit-annotation-subtype" ${pdfkitLegacyReady ? '' : 'disabled'}>
            ${[['text', 'Sticky note'], ['freeText', 'Free text'], ['square', 'Square'], ['circle', 'Circle'], ['highlight', 'Highlight']].map(([value, label]) => `<option value="${value}" ${state.pdfkitAnnotationSubtype === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <p class="field-help">Sticky notes may open a viewer-provided popup, but this profile embeds no PDF action. Contents are stored in the separate derived PDF.</p>
          <label class="field-label" for="pdfkit-annotation-contents">Contents</label>
          <textarea id="pdfkit-annotation-contents" maxlength="1024" rows="3" ${pdfkitLegacyReady ? '' : 'disabled'}>${escapeHtml(state.pdfkitAnnotationContents ?? '')}</textarea>
          <div class="numeric-grid" aria-label="Annotation rectangle in PDF points">
            <label>X <input id="pdfkit-annotation-x" type="number" step="0.1" value="${escapeHtml(state.pdfkitAnnotationRect?.x ?? 36)}" ${pdfkitLegacyReady ? '' : 'disabled'} /></label>
            <label>Y <input id="pdfkit-annotation-y" type="number" step="0.1" value="${escapeHtml(state.pdfkitAnnotationRect?.y ?? 36)}" ${pdfkitLegacyReady ? '' : 'disabled'} /></label>
            <label>Width <input id="pdfkit-annotation-width" type="number" min="0.1" step="0.1" value="${escapeHtml(state.pdfkitAnnotationRect?.width ?? 180)}" ${pdfkitLegacyReady ? '' : 'disabled'} /></label>
            <label>Height <input id="pdfkit-annotation-height" type="number" min="0.1" step="0.1" value="${escapeHtml(state.pdfkitAnnotationRect?.height ?? 80)}" ${pdfkitLegacyReady ? '' : 'disabled'} /></label>
          </div>
          <button class="button primary" data-action="create-pdfkit-annotation-copy" ${pdfkitLegacyReady ? '' : 'disabled'}>Create derived PDF</button>
        </details>`;
}

export function pdfkitBasicEditSections(state, context) {
  return metadataAndBoxSections(state, context)
    + overlaySections(state, context)
    + pdfKitFallbackSections(state, context);
}
