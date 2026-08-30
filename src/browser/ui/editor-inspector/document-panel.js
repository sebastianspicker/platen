import { escapeHtml, formatBytes } from '../shared.js';
import { namedDestinationInventory, signatureAudit } from '../document-evidence-view.js';
import { pdfkitInspectionResult } from '../editor-result-views.js';

export function property(label, value) {
  return `<div class="property-row"><span>${escapeHtml(label)}</span><span class="property-value">${escapeHtml(value ?? '—')}</span></div>`;
}

/** Renders immutable source, Poppler evidence, and optional PDFKit inventory. */
export function creationPanel(state) {
  const conversionReady = state.host?.conversionReady && !state.busyAction;
  return `<section class="property-section creation-section">
        <h3>Create &amp; convert</h3>
        <label class="field-label" for="new-document-title">Title</label>
        <input id="new-document-title" maxlength="200" value="${escapeHtml(state.creationTitle ?? 'Untitled')}" />
        <label class="field-label" for="blank-page-count">Blank pages</label>
        <input id="blank-page-count" type="number" min="1" max="500" step="1" value="${escapeHtml(state.blankPageCount ?? 1)}" />
        <button class="button" data-action="create-blank-document" ${conversionReady ? '' : 'disabled'}>Create blank PDF</button>
        <label class="field-label" for="new-document-text">Text for a new PDF</label>
        <textarea id="new-document-text" maxlength="1000000" rows="4" placeholder="Paste local text here">${escapeHtml(state.creationText ?? '')}</textarea>
        <button class="button" data-action="create-text-document" ${conversionReady ? '' : 'disabled'}>Create text PDF</button>
        <button class="button" data-action="create-from-clipboard" ${conversionReady ? '' : 'disabled'}>Create from clipboard…</button>
        <button class="button" data-action="create-clipboard-to-pdf" ${conversionReady ? '' : 'disabled'}>Create image PDF from clipboard…</button>
        <button class="button" data-action="choose-conversion-file" ${conversionReady ? '' : 'disabled'}>Convert local file…</button>
        <button class="button" data-action="choose-combine-files" ${conversionReady ? '' : 'disabled'}>Combine mixed files…</button>
        <p class="field-help">Supports bounded PNG, JPEG, and TIFF images; DOCX/PPTX/XLSX; OpenDocument; text/CSV/RTF; passive HTML; and PS/EPS inputs. Each conversion or combination opens a separate derived PDF and leaves every source unchanged. Legacy Office and DXF depend on a working local LibreOffice process. Clipboard image creation accepts exactly one non-empty PNG representation and creates one separate page without OCR.</p>
      </section>`;
}

export function documentPanel(state, { analysis, info, structure, selectedBoxEvidence, ready }) {
  const document = state.document;
  return `<section class="property-section">
        <h3>Local source</h3>
        ${property('File', document.name ?? 'No PDF open')}
        ${property('Size', document.isOpen ? formatBytes(document.size) : '—')}
        ${property('Source', document.isOpen ? 'Immutable' : '—')}
        ${property('Host', state.host?.status === 'ready' ? 'Connected locally' : state.host?.status === 'unavailable' ? 'Preview only' : 'Connecting')}
      </section>
      <section class="property-section">
        <h3>PDF properties</h3>
        ${property('Pages', info?.pageCount)}
        ${property('Version', info?.pdfVersion)}
        ${property('Page size', info?.pageSize)}
        ${property('Tagged', info?.tagged)}
        ${property('Encrypted', info?.encrypted)}
        ${property('JavaScript', info?.javascript)}
        ${property('Optimized', info?.optimized)}
        ${info?.title ? property('Title', info.title) : ''}
        ${info?.author ? property('Author', info.author) : ''}
      </section>
      <section class="property-section">
        <h3>Resource audit</h3>
        ${property('Fonts', analysis.fonts.length)}
        ${property('Images', analysis.images.length)}
        ${property('Attachments', analysis.attachments.length)}
        ${signatureAudit(analysis.signatures, property)}
        ${analysis.fonts.slice(0, 4).map((font) => property('Font', `${font.name} · ${font.embedded === 'yes' ? 'embedded' : 'not embedded'}`)).join('')}
        ${analysis.attachments.slice(0, 4).map((attachment) => property(`Attachment ${attachment.number}`, attachment.name)).join('')}
      </section>
      <section class="property-section">
        <h3>Native structure evidence</h3>
        ${property('Page-box records', structure?.pageBoxes?.length ?? '—')}
        ${property('Named destinations', structure?.namedDestinations?.items?.length ?? '—')}
        ${property('Object URLs', structure?.urls?.length ?? '—')}
        ${property('XMP metadata', structure ? (structure.xmpMetadata?.present ? 'Present' : 'Not present') : '—')}
        ${property('Tag structure', structure ? (structure.taggedStructure?.present ? `${structure.taggedStructure.lines.length} records` : 'Not reported') : '—')}
        ${selectedBoxEvidence ? property('Selected CropBox', `${selectedBoxEvidence.boxes.cropBox.width} × ${selectedBoxEvidence.boxes.cropBox.height} pt`) : ''}
        ${(structure?.customMetadata ?? []).slice(0, 4).map(({ name, value }) => property(name, value)).join('')}
        <button class="button" data-action="run-pdfkit-inspection" ${ready && state.host?.pdfkitInspectionReady ? '' : 'disabled'}>Inspect with pinned macOS PDFKit</button>
        <p class="field-help">Read-only Poppler evidence preserves the source and inventories page boxes, XMP/custom metadata, named destinations, URLs, and tags. The optional release-built macOS helper adds bounded outlines, logical page labels, inert link actions, optional-content group names, annotation/widget types, opaque exact-source locators, permissions, metadata, rotations, and resolved page boxes.${state.host?.pdfkitInspectionReady ? '' : ' Build the optional release helper with npm run native:build:pdfkit to enable it on macOS.'} Source-bound controls can create one verified local page link, one inert straight line, one open ink path, or a separate PDF with inspected optional-content default visibility changes; full layer authoring and navigation management remain outside this bounded subset.</p>
        ${namedDestinationInventory(structure)}
        ${pdfkitInspectionResult(state)}
      </section>`;
}
