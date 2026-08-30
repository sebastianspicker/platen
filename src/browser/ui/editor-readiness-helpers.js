export const validArtifactId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '');
export const validDigest = (value) => /^[0-9a-f]{64}$/.test(value ?? '');
export const RECT_KEYS = Object.freeze(['x', 'y', 'width', 'height']);

export function countOutlineItems(items) {
  if (!Array.isArray(items)) return Number.POSITIVE_INFINITY;
  return items.reduce((count, item) => count + 1 + countOutlineItems(item?.children), 0);
}

export function rectangleContains(outer, inner) {
  return Boolean(outer) && Boolean(inner)
    && inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function selectedPageBoxReadiness(state, page) {
  const box = state.pdfkitPageBox;
  const verified = ['crop', 'bleed'].includes(box);
  if (!verified) return Object.freeze({ verified, geometryReady: false, changed: false });
  const requested = Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [key, Number(state.pdfkitPageBoxRect?.[key])]),
  );
  const source = page?.boxes?.[box];
  const validNumbers = Object.values(requested).every(Number.isFinite)
    && requested.width > 0 && requested.height > 0;
  const productionContainment = box !== 'bleed'
    || rectangleContains(requested, page?.boxes?.trim);
  return Object.freeze({
    verified,
    geometryReady: validNumbers
      && rectangleContains(page?.boxes?.media, requested)
      && productionContainment,
    changed: Boolean(source) && ['x', 'y', 'width', 'height'].some(
      (key) => Math.abs(requested[key] - source[key]) > 0.01,
    ),
  });
}

export function passiveIncrementalSourceReady({ ready, unsigned, info, formKind, analysis, structure }) {
  return ready && unsigned
    && String(info?.encrypted ?? '').toLowerCase() === 'no'
    && formKind === 'none' && String(info?.javascript ?? '').toLowerCase() === 'no'
    && Number.isSafeInteger(info?.pageCount) && info.pageCount >= 1 && info.pageCount <= 100
    && Array.isArray(analysis.attachments) && analysis.attachments.length === 0
    && structure?.xmpMetadata?.present === false
    && Array.isArray(structure?.urls) && structure.urls.length === 0;
}

export function safeRewriteSourceReady({ ready, unsigned, info, formKind, analysis, structure }) {
  return ready && unsigned && String(info?.encrypted ?? '').toLowerCase() === 'no'
    && formKind === 'none' && String(info?.javascript ?? '').toLowerCase() === 'no'
    && String(info?.tagged ?? '').toLowerCase() === 'no'
    && Number.isSafeInteger(info?.pageCount) && info.pageCount >= 1 && info.pageCount <= 100
    && Array.isArray(analysis.attachments) && analysis.attachments.length === 0
    && Array.isArray(structure?.urls) && structure.urls.length === 0;
}

export function javascriptRemovalSourceReady({ state, ready, unsigned, info, formKind, analysis, structure }) {
  return ready && unsigned && state.host?.javascriptRemovalReady === true
    && String(info?.encrypted ?? '').toLowerCase() === 'no' && formKind === 'none'
    && String(info?.javascript ?? '').toLowerCase() === 'yes'
    && Number.isSafeInteger(info?.pageCount) && info.pageCount >= 1 && info.pageCount <= 100
    && Array.isArray(analysis.attachments) && analysis.attachments.length === 0
    && structure?.xmpMetadata?.present === false
    && Array.isArray(structure?.urls) && structure.urls.length === 0;
}

export function attachmentRemovalSourceReady({ state, ready, unsigned, info, formKind, analysis, structure }) {
  const attachment = Array.isArray(analysis.attachments)
    && analysis.attachments.length === 1 ? analysis.attachments[0] : null;
  return ready && unsigned && state.host?.attachmentRemovalReady === true
    && String(info?.encrypted ?? '').toLowerCase() === 'no' && formKind === 'none'
    && String(info?.javascript ?? '').toLowerCase() === 'no'
    && String(info?.tagged ?? '').toLowerCase() === 'no'
    && Number.isSafeInteger(info?.pageCount) && info.pageCount >= 1 && info.pageCount <= 100
    && attachment?.number === 1 && typeof attachment.name === 'string'
    && /^[\x20-\x7e]{1,240}$/.test(attachment.name)
    && structure?.xmpMetadata?.present === false
    && Array.isArray(structure?.urls) && structure.urls.length === 0;
}

export function incrementalBleedBoxRequestFromState(state) {
  return {
    page: Number(state.selectedPage),
    rect: Object.fromEntries(['x', 'y', 'width', 'height'].map(
      (key) => [key, Number(state.pdfkitPageBoxRect?.[key])],
    )),
  };
}

export function incrementalGoToLinkRequestFromState(state) {
  const x = Number(state.pdfkitLinkRect?.x); const y = Number(state.pdfkitLinkRect?.y);
  const width = Number(state.pdfkitLinkRect?.width); const height = Number(state.pdfkitLinkRect?.height);
  return {
    sourcePage: Number(state.selectedPage), targetPage: Number(state.pdfkitLinkTargetPage),
    rect: { left: x, bottom: y, right: x + width, top: y + height },
  };
}

export function incrementalPageVectorRequestFromState(state) {
  return {
    page: Number(state.selectedPage),
    rect: Object.fromEntries(RECT_KEYS.map((key) => [key, Number(state.incrementalPageVectorRect?.[key])])),
  };
}

export function pageTextRequestFromState(state) {
  return {
    page: Number(state.selectedPage),
    x: Number(state.pageTextRun?.x), y: Number(state.pageTextRun?.y),
    size: Number(state.pageTextRun?.size), text: String(state.pageTextRun?.text ?? ''),
  };
}
