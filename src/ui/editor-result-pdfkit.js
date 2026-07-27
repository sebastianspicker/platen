import { escapeHtml } from './shared.js';

function collectOutlineEntries(items, result = [], depth = 0) {
  if (!Array.isArray(items) || depth >= 8 || result.length >= 200) return result;
  for (const item of items) {
    if (result.length >= 200) break;
    if (item && typeof item === 'object') {
      result.push({
        title: typeof item.title === 'string' && item.title
          ? item.title : 'Untitled outline entry',
        page: item.page,
      });
    }
    collectOutlineEntries(item?.children, result, depth + 1);
  }
  return result;
}

export function pdfkitInspectionResult(state) {
  const result = state.pdfkitInspectionResult;
  if (!result) return '';
  const pages = Array.isArray(result.pages) ? result.pages.slice(0, 100) : [];
  const annotationCount = pages.reduce(
    (count, page) => count + (Array.isArray(page?.annotations) ? page.annotations.length : 0),
    0,
  );
  const widgetCount = pages.reduce(
    (count, page) => count + (Array.isArray(page?.widgets) ? page.widgets.length : 0),
    0,
  );
  const links = pages.flatMap((page) => (Array.isArray(page?.links)
    ? page.links.map((link) => ({ ...link, sourcePage: page.index })) : [])).slice(0, 20);
  const pageLabels = result.pageLabels?.present && Array.isArray(result.pageLabels.items)
    ? result.pageLabels.items.slice(0, 100) : [];
  const displayedPageLabels = pageLabels.slice(0, 20);
  const pageLabelsTruncated = result.pageLabels?.truncated === true
    || pageLabels.length > displayedPageLabels.length;
  const optionalContentGroups = result.optionalContent?.present
    && Array.isArray(result.optionalContent.groups)
    ? result.optionalContent.groups.slice(0, 20) : [];
  const buttonControls = pages.flatMap((page) => (Array.isArray(page?.widgets)
    ? page.widgets
      .filter(({ fieldType }) => fieldType === 'button')
      .map((widget) => ({ ...widget, page: page.index }))
    : [])).slice(0, 20);
  const outlineEntries = collectOutlineEntries(result.outline?.items);
  const displayedOutlineEntries = outlineEntries.slice(0, 20);
  const outlineTruncated = result.outline?.truncated === true
    || outlineEntries.length > displayedOutlineEntries.length;
  return `<div class="comparison-result" role="status">
    <strong>Pinned Apple PDFKit inventory</strong>
    <span>${escapeHtml(result.pageCount ?? 0)} pages · ${escapeHtml(annotationCount)} bounded annotation records · ${escapeHtml(widgetCount)} bounded widget records · ${escapeHtml(links.length)} displayed links · ${escapeHtml(outlineEntries.length)} displayed outline labels</span>
    ${result.metadata?.title ? `<span>Title: ${escapeHtml(result.metadata.title)}</span>` : ''}
    ${result.pageLabels?.present ? `<strong>Logical page labels</strong>${displayedPageLabels.length ? `<ul class="preflight-checks">${displayedPageLabels.map(({ page, label }) => `<li><button class="status-action" data-page-number="${page}">${escapeHtml(label)} · physical page ${page}</button></li>`).join('')}</ul>` : '<span>No logical page labels were retained.</span>'}${pageLabelsTruncated ? '<span>Logical page labels are truncated at 100 retained pages or to the first 20 displayed here. Export the JSON inventory for every retained label.</span>' : ''}` : ''}
    <strong>Bookmarks and outlines</strong>
    ${displayedOutlineEntries.length ? `<ul class="preflight-checks">${displayedOutlineEntries.map(({ title, page }) => `<li>${Number.isSafeInteger(page) && page >= 1 && page <= result.pageCount ? `<button class="status-action" data-page-number="${page}">${escapeHtml(title)} · page ${page}</button>` : `<span>${escapeHtml(title)} · unresolved destination</span>`}</li>`).join('')}</ul>` : '<span>No bookmark or outline entries were found.</span>'}
    ${outlineTruncated ? '<span>Bookmark inventory is truncated at the helper’s 200-item or 8-level bound, or to the first 20 entries displayed here. Export the JSON inventory for every retained entry.</span>' : ''}
    ${links.length ? `<strong>Inert link inventory</strong><ul class="preflight-checks">${links.map((link) => `<li>${link.kind === 'goTo' && Number.isSafeInteger(link.targetPage) && link.targetPage >= 1 && link.targetPage <= result.pageCount ? `<button class="status-action" data-page-number="${link.targetPage}">Page ${link.sourcePage} link → page ${link.targetPage}</button>` : `<span>Page ${escapeHtml(link.sourcePage)} · ${escapeHtml(link.kind)}${link.target ? ` · ${escapeHtml(link.target)}` : ''}${link.remotePage ? ` · remote page ${escapeHtml(link.remotePage)}` : ''}</span>`}</li>`).join('')}</ul>` : ''}
    ${buttonControls.length ? `<strong>AcroForm button controls</strong><ul class="preflight-checks">${buttonControls.map((widget) => `<li><span>${escapeHtml(widget.fieldName || 'Unnamed field')} · ${escapeHtml(widget.controlKind)} · page ${escapeHtml(widget.page)} annotation ${escapeHtml(widget.annotationIndex)} · ${['checkbox', 'radio'].includes(widget.controlKind) ? 'eligible for private validation below' : 'inventory only'}</span></li>`).join('')}</ul>` : ''}
    ${result.optionalContent?.present ? `<strong>Layers · ${escapeHtml(result.optionalContent.groupCount)} group${result.optionalContent.groupCount === 1 ? '' : 's'}</strong>${optionalContentGroups.length ? `<ul class="preflight-checks">${optionalContentGroups.map(({ index, name, defaultVisible }) => `<li><span>${escapeHtml(name ?? `Unnamed group ${index + 1}`)} · default ${defaultVisible === null ? 'unknown' : defaultVisible ? 'visible' : 'hidden'} · read-only inventory</span></li>`).join('')}</ul>` : ''}<span>Layers cannot be toggled or edited in this inventory; source-bound controls below can create a separate default-visibility copy.</span>` : ''}
    <button class="button" data-action="export-pdfkit-inspection">Export JSON inventory</button>
    <span>This is a bounded, read-only inventory. Resolved local outlines, named destinations, page labels, and local links navigate the open PDF. External and remote targets are inert text. Layers cannot be toggled or edited in this inventory; source-bound controls below can create a separate default-visibility copy. Button control kinds expose no current value, export/on-state name, or appearance data. Separate source-bound profiles can set one privately verified checkbox, select one option in a canonical radio group, author one strictly local GoTo link, remove one exact strict local-link occurrence, append one top-level direct bookmark, or remove one exact top-level leaf bookmark; push controls remain inventory only. This inventory itself does not edit objects, validate conformance, or claim signature-safe rewriting.</span>
  </div>`;
}

function limitations(result) {
  return Array.isArray(result.limitations) ? result.limitations.slice(0, 3) : [];
}

function limitationMarkup(result) {
  return limitations(result)
    .map((limitation) => `<span>${escapeHtml(limitation)}</span>`)
    .join('');
}

export function pdfkitMutationResult(state) {
  const result = state.pdfkitMutationResult;
  if (!result) return '';
  return `<div class="comparison-result" role="status">
    <strong>PDFKit-derived PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Derived PDF')} · ${escapeHtml(result.appliedEdits ?? 0)} requested field${result.appliedEdits === 1 ? '' : 's'} processed and verified</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function pdfkitLayerDefaultsResult(state) {
  const result = state.pdfkitLayerResult;
  if (result?.kind !== 'pdf-layer-defaults') return '';
  const visible = result.proof?.visibleGroupIndices?.length ?? 0;
  const hidden = result.proof?.hiddenGroupIndices?.length ?? 0;
  return `<div class="comparison-result" role="status"><strong>Layer-visibility PDF created</strong><span>${escapeHtml(result.artifact?.displayName ?? 'Layer-visibility PDF')} · ${escapeHtml(visible)} visible · ${escapeHtml(hidden)} hidden defaults verified</span><span>The source digest was bound before writing and the immutable source remains unchanged.</span></div>`;
}

export function pdfkitTextFieldWidgetResult(state) {
  const result = state.pdfkitTextFieldWidgetResult;
  if (result?.kind !== 'pdfkit-acroform-text-field-widget') return '';
  return `<div class="comparison-result" role="status"><strong>Text-field widget PDF created</strong><span>${escapeHtml(result.artifact?.displayName ?? 'Text-field widget PDF')} · page ${escapeHtml(result.page ?? '')} · one direct terminal widget</span>${limitationMarkup(result)}</div>`;
}

export function incrementalMetadataResult(state) {
  const result = state.incrementalMetadataResult;
  if (result?.kind !== 'pdf-incremental-metadata') return '';
  return `<div class="comparison-result" role="status">
    <strong>Object-preserving metadata PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Incremental metadata PDF')} · source bytes preserved as the exact prefix · fresh Info object appended</span>
    <span>Poppler independently matched metadata, page text, geometry, and every rendered page.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function incrementalBleedBoxResult(state) {
  const result = state.incrementalBleedBoxResult;
  if (result?.kind !== 'pdf-incremental-bleed-box') return '';
  return `<div class="comparison-result" role="status">
    <strong>Structure-preserving BleedBox PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Incremental BleedBox PDF')} · page ${escapeHtml(result.pageBox?.page ?? '')} · same page object revised · source bytes preserved as the exact prefix</span>
    <span>Poppler independently matched page text and non-target geometry; every fixed 256-pixel-long-edge validation render matched.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function incrementalGoToLinkResult(state) {
  const result = state.incrementalGoToLinkResult;
  if (result?.kind !== 'pdf-incremental-goto-link') return '';
  return `<div class="comparison-result" role="status">
    <strong>Structure-preserving local-link PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Incremental local-link PDF')} · page ${escapeHtml(result.link?.sourcePage ?? '')} → page ${escapeHtml(result.link?.targetPage ?? '')} · source bytes preserved as the exact prefix</span>
    <span>Poppler independently matched page text, boxes, and every fixed 256-pixel validation render.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function incrementalNamedDestinationResult(state) {
  const result = state.incrementalNamedDestinationResult;
  if (result?.kind !== 'pdf-incremental-named-destination') return '';
  return `<div class="comparison-result" role="status">
    <strong>Structure-preserving named-destination PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Incremental named-destination PDF')} · one digest-bound /Fit target to page ${escapeHtml(result.destination?.targetPage ?? '')} · source bytes preserved as the exact prefix</span>
    <span>Poppler independently reported exactly the new destination and matched page text, boxes, and every fixed 256-pixel validation render.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function incrementalPageVectorResult(state) {
  const result = state.incrementalPageVectorResult;
  if (result?.kind !== 'pdf-incremental-page-vector') return '';
  return `<div class="comparison-result" role="status">
    <strong>Structure-preserving page-vector PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Incremental page-vector PDF')} · page ${escapeHtml(result.vector?.page ?? '')} · source bytes preserved as the exact prefix</span>
    <span>The validation run changed only the selected target page render and preserved every other render, page text, and page-box layout.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function pageTextResult(state) {
  const result = state.pageTextResult;
  if (result?.kind !== 'pdf-page-text-run') return '';
  return `<div class="comparison-result" role="status">
    <strong>Append-only page-text PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Page-text PDF')} · page ${escapeHtml(result.text?.page ?? '')} · ${escapeHtml(result.text?.size ?? '')}pt black Helvetica · source bytes preserved as the exact prefix</span>
    <span>One printable-ASCII run was validated on the selected content-empty page. Historical bytes remain retained; this is not general text editing.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function javascriptRemovalResult(state) {
  const result = state.javascriptRemovalResult;
  if (result?.kind !== 'pdf-javascript-removal') return '';
  return `<div class="comparison-result" role="status">
    <strong>Document JavaScript removal copy created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'JavaScript-removed PDF')} · one ${escapeHtml(result.removal?.removedLocus ?? 'document-level')} locus removed · fresh closed classic revision</span>
    <span>Prior revisions and unreachable objects are absent from this derived copy; the immutable source remains unchanged.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function attachmentRemovalResult(state) {
  const result = state.attachmentRemovalResult;
  if (result?.kind !== 'pdf-document-attachment-removal') return '';
  return `<div class="comparison-result" role="status">
    <strong>Embedded attachment removal copy created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Attachment-removed PDF')} · ${escapeHtml(result.removal?.contentBytes ?? '')} attachment bytes removed · fresh closed classic revision</span>
    <span>Poppler independently extracted and digest-bound the source attachment, then reported no output attachments. The immutable source remains unchanged.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function annotationFlattenResult(state) {
  const result = state.annotationFlattenResult;
  if (result?.kind !== 'pdf-square-annotation-flatten') return '';
  return `<div class="comparison-result" role="status">
    <strong>Square annotation flattened into page content</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Annotation-flattened PDF')} · page ${escapeHtml(result.flatten?.page ?? '')} · fresh closed classic revision</span>
    <span>The source-bound normal appearance was promoted into page content; the annotation object and prior revisions are absent, and every fixed validation render matched.</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function pdfkitProtectionResult(state) {
  const result = state.pdfkitProtectionResult;
  if (result?.kind !== 'pdfkit-password-protection') return '';
  const protection = result.protection ?? {};
  const permissions = Array.isArray(protection.effectivePermissions)
    && protection.effectivePermissions.length
    ? protection.effectivePermissions.join(', ') : 'none';
  return `<div class="comparison-result" role="status">
    <strong>Password-protected PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Protected PDF')} · ${escapeHtml(protection.cipher ?? 'AES-128-CBC')} · ${escapeHtml(protection.permissionsProfile ?? 'fixed permissions')}</span>
    <span>Advisory permissions: ${escapeHtml(permissions)}</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function pdfkitProtectionRemovalResult(state) {
  const result = state.pdfkitProtectionRemovalResult;
  if (result?.kind !== 'pdfkit-protection-removal') return '';
  const protection = result.protection ?? {};
  return `<div class="comparison-result" role="status">
    <strong>Separate unencrypted PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Unencrypted PDF')} · ${protection.ownerAuthorizationVerified === true ? 'owner authorization verified' : 'owner authorization not verified'} · ${protection.encrypted === false ? 'no protection retained' : 'protection status unavailable'}</span>
    ${limitationMarkup(result)}
  </div>`;
}

export function pdfkitMetadataSanitizationResult(state) {
  const result = state.pdfkitSanitizationResult;
  if (result?.kind !== 'pdfkit-metadata-sanitization') return '';
  const categories = Array.isArray(result.sanitization?.removedCategories)
    ? result.sanitization.removedCategories.join(', ') : 'fixed metadata categories';
  return `<div class="comparison-result" role="status">
    <strong>Metadata-sanitized PDF created</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Metadata-sanitized PDF')} · removed: ${escapeHtml(categories)}</span>
    <span>Native bounded content snapshot matched · Poppler independently confirmed metadata absence and rendered every output page</span>
    ${limitationMarkup(result)}
  </div>`;
}
