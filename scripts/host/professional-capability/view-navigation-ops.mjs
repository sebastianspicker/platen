import { createHash, randomUUID } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { searchPdfAdvancedText } from '../pdf-advanced-search.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import { createPdfPortfolio } from './portfolio-pdf.mjs';

const sessions = new Map();

function admitSource(ctx) {
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? createBlankPdf({ pages: 1 }), 'sourcePdf');
  return { source, sourceSha256: sha256(source) };
}

export function documentOpenLocal(ctx = {}) {
  const { source, sourceSha256 } = admitSource(ctx);
  const sessionId = randomUUID();
  sessions.set(sessionId, { sourceSha256, openedVia: 'local-path', open: true });
  return result('document.open.local', {
    method: 'local-document-open-path',
    sessionId,
    sourceSha256,
    open: true,
    bytes: source.length,
  });
}

export function documentOpenDragDrop(ctx = {}) {
  const fileName = requireString(ctx.fileName ?? 'dropped.pdf', 'fileName', { min: 1, max: 200 });
  if (!/\.pdf$/i.test(fileName) || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    fail('INVALID_DROP_NAME', 'Drag-drop fileName must be a bare .pdf name.', 400);
  }
  const { source, sourceSha256 } = admitSource(ctx);
  const sessionId = randomUUID();
  sessions.set(sessionId, { sourceSha256, openedVia: 'drag-drop', fileName, open: true });
  return result('document.open.drag-drop', {
    method: 'local-document-open-drag-drop',
    sessionId,
    fileName,
    sourceSha256,
    open: true,
    bytes: source.length,
  });
}

export function documentClose(ctx = {}) {
  const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId : null;
  if (sessionId && sessions.has(sessionId)) sessions.delete(sessionId);
  return result('document.close', {
    method: 'local-document-close',
    sessionId,
    closed: true,
    remainingSessions: sessions.size,
  });
}

export function documentDownloadOriginal(ctx = {}) {
  const { source, sourceSha256 } = admitSource(ctx);
  return result('document.download.original', {
    method: 'local-document-download-original',
    sourceSha256,
    outputSha256: sourceSha256,
    pdf: source,
    bytes: source.length,
  });
}

export function viewerNativeRender(ctx = {}) {
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  if (page < 1 || page > 9999) fail('INVALID_PAGE', 'page out of range', 400);
  const { source, sourceSha256 } = admitSource(ctx);
  const fingerprint = createHash('sha256').update(source.subarray(0, Math.min(512, source.length))).update(String(page)).digest('hex');
  return result('viewer.native.render', {
    method: 'local-viewer-page-render-fingerprint',
    sourceSha256,
    page,
    renderFingerprint: fingerprint,
    widthPoints: 612,
    heightPoints: 792,
  });
}

export function viewerZoomPreview(ctx = {}) {
  const zoom = Number(ctx.zoom ?? 1.25);
  if (!(zoom >= 0.1 && zoom <= 64)) fail('INVALID_ZOOM', 'zoom must be 0.1..64', 400);
  return result('viewer.zoom.preview', {
    method: 'local-viewer-zoom-state',
    zoom,
    zoomPercent: Math.round(zoom * 100),
    viewState: Object.freeze({ zoom, mode: 'zoom-preview' }),
  });
}

export function viewerRotatePreview(ctx = {}) {
  const rotation = [0, 90, 180, 270].includes(ctx.rotation) ? ctx.rotation : 90;
  return result('viewer.rotate.preview', {
    method: 'local-viewer-rotate-state',
    rotation,
    viewState: Object.freeze({ rotation, mode: 'rotate-preview' }),
  });
}

export function viewerFullscreen(ctx = {}) {
  const enabled = ctx.enabled !== false;
  return result('viewer.fullscreen', {
    method: 'local-viewer-fullscreen-request',
    fullscreen: enabled,
    viewState: Object.freeze({ fullscreen: enabled }),
  });
}

export function viewerThumbnails(ctx = {}) {
  const pageCount = Number.isSafeInteger(ctx.pageCount) ? ctx.pageCount : 3;
  if (pageCount < 1 || pageCount > 500) fail('INVALID_PAGE_COUNT', 'pageCount 1..500', 400);
  const thumbnails = Array.from({ length: pageCount }, (_, i) => ({
    page: i + 1,
    label: `Page ${i + 1}`,
    width: 96,
    height: 128,
  }));
  return result('viewer.thumbnails', {
    method: 'local-viewer-thumbnail-index',
    thumbnails,
    count: thumbnails.length,
  });
}

export function viewerSearch(ctx = {}) {
  const text = requireString(ctx.text ?? 'Evidence alpha beta. Contract value is $12,000.', 'text', { min: 1, max: 200_000 });
  const query = requireString(ctx.query ?? 'Contract', 'query', { min: 1, max: 200 });
  const sourceSha256 = createHash('sha256').update(text).digest('hex');
  const found = searchPdfAdvancedText({
    profile: 'local-pdf-advanced-search-v1',
    sourceSha256,
    pages: [{ page: 1, text }],
    query,
    mode: 'literal',
    caseSensitive: false,
    wholeWord: false,
    context: 12,
    maxResults: 50,
  });
  return result('viewer.search', {
    method: 'local-viewer-extracted-text-search',
    query,
    totalMatches: found.totalMatches,
    matches: found.matches,
    search: found,
  });
}

export function viewerAdvancedSearch(ctx = {}) {
  const text = requireString(ctx.text ?? 'Evidence alpha beta. Contract value is $12,000. Email j.doe@example.com', 'text', { min: 1, max: 200_000 });
  const query = requireString(ctx.query ?? 'j.doe*', 'query', { min: 1, max: 200 });
  const sourceSha256 = createHash('sha256').update(text).digest('hex');
  const found = searchPdfAdvancedText({
    profile: 'local-pdf-advanced-search-v1',
    sourceSha256,
    pages: [{ page: 1, text }],
    query,
    mode: query.includes('*') || query.includes('?') ? 'wildcard' : 'literal',
    caseSensitive: Boolean(ctx.caseSensitive),
    wholeWord: Boolean(ctx.wholeWord),
    context: 20,
    maxResults: 100,
  });
  return result('viewer.advanced-search', {
    method: 'local-viewer-advanced-search-core',
    query,
    mode: found.mode,
    totalMatches: found.totalMatches,
    matches: found.matches,
    search: found,
  });
}


export function viewerPageLayouts(ctx = {}) {
  const layout = ['single', 'continuous', 'two-up', 'two-up-continuous'].includes(ctx.layout) ? ctx.layout : 'continuous';
  return result('viewer.page-layouts', {
    method: 'local-viewer-page-layout-mode',
    layout,
    viewState: Object.freeze({ layout }),
  });
}

export function viewerMultidocumentTabs(ctx = {}) {
  const tabs = Array.isArray(ctx.tabs)
    ? ctx.tabs.slice(0, 32)
    : [{ id: 't1', title: 'A.pdf' }, { id: 't2', title: 'B.pdf' }];
  const activeId = ctx.activeId ?? tabs[0]?.id ?? null;
  return result('viewer.multidocument-tabs', {
    method: 'local-viewer-document-tabs',
    tabs,
    activeId,
    count: tabs.length,
  });
}

export function viewerSplitView(ctx = {}) {
  const orientation = ctx.orientation === 'horizontal' ? 'horizontal' : 'vertical';
  const ratio = Number(ctx.ratio ?? 0.5);
  if (!(ratio > 0 && ratio < 1)) fail('INVALID_SPLIT', 'ratio must be (0,1)', 400);
  return result('viewer.split-view', {
    method: 'local-viewer-split-panes',
    orientation,
    ratio,
    panes: 2,
  });
}

export function viewerReflow(ctx = {}) {
  const text = requireString(ctx.text ?? 'Reflow paragraph one. Reflow paragraph two.', 'text', { min: 1, max: 100_000 });
  const columns = Number.isSafeInteger(ctx.columns) ? ctx.columns : 1;
  if (columns < 1 || columns > 4) fail('INVALID_COLUMNS', 'columns 1..4', 400);
  const blocks = text.split(/\.\s+/).filter(Boolean).map((t, i) => ({ order: i + 1, text: t.slice(0, 500) }));
  return result('viewer.reflow', {
    method: 'local-viewer-reflow-blocks',
    columns,
    blocks,
    count: blocks.length,
  });
}

export function viewerReadAloud(ctx = {}) {
  const text = requireString(ctx.text ?? 'Read this sentence aloud.', 'text', { min: 1, max: 50_000 });
  const rate = Number(ctx.rate ?? 1);
  if (!(rate >= 0.5 && rate <= 2)) fail('INVALID_RATE', 'rate 0.5..2', 400);
  const utterances = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 200).map((u, i) => ({
    index: i,
    text: u.slice(0, 400),
    charCount: u.length,
  }));
  return result('viewer.read-aloud', {
    method: 'local-viewer-read-aloud-plan',
    rate,
    utterances,
    totalChars: text.length,
  });
}

export function viewerAttachments(ctx = {}) {
  // Real embedded-file packaging via portfolio assembly (/EmbeddedFiles /Filespec).
  const files = Array.isArray(ctx.files) && ctx.files.length
    ? ctx.files
    : (Array.isArray(ctx.attachments)
      ? ctx.attachments.map((a, i) => ({
        name: String(a.name ?? `file-${i}.txt`),
        bytes: Buffer.isBuffer(a.bytes) ? a.bytes : Buffer.from(String(a.content ?? a.name ?? `payload-${i}`), 'utf8'),
        description: String(a.description ?? 'attachment'),
      }))
      : [{ name: 'spec.txt', bytes: Buffer.from('specification body', 'utf8'), description: 'Spec' }]);
  const built = createPdfPortfolio(files.slice(0, 32), { title: ctx.title ?? 'Attachments' });
  const pdf = Buffer.isBuffer(built.bytes) ? built.bytes : Buffer.from(built.bytes);
  const latin1 = pdf.toString('latin1');
  if (!latin1.includes('/EmbeddedFiles') && !latin1.includes('/Filespec') && !latin1.includes('/EF')) {
    fail('EMBEDDED_FILES_MISSING', 'Portfolio did not emit embedded-file markers.', 502);
  }
  const list = (built.files ?? files).map((f) => ({
    name: f.name,
    size: f.size ?? f.bytes?.length ?? 0,
    sha256: f.sha256,
  }));
  return result('viewer.attachments', {
    method: 'local-pdf-embedded-file-collection',
    attachments: list,
    count: list.length,
    outputSha256: sha256(pdf),
    pdf,
    bytes: pdf.length,
    embeddedFiles: true,
    pageMode: built.pageMode ?? 'UseAttachments',
  });
}

export function viewerLayers(ctx = {}) {
  const layers = Array.isArray(ctx.layers)
    ? ctx.layers.slice(0, 50)
    : [{ name: 'Base', visible: true }, { name: 'Markup', visible: true }];
  return result('viewer.layers', {
    method: 'local-viewer-layer-visibility',
    layers,
    visibleCount: layers.filter((l) => l.visible !== false).length,
  });
}

export function viewerDestinations(ctx = {}) {
  const destinations = Array.isArray(ctx.destinations)
    ? ctx.destinations.slice(0, 100)
    : [{ name: 'Cover', page: 1 }, { name: 'TOC', page: 2 }];
  return result('viewer.destinations', {
    method: 'local-viewer-named-destinations',
    destinations,
    count: destinations.length,
  });
}

export function viewerPageLabels(ctx = {}) {
  const labels = Array.isArray(ctx.labels) ? ctx.labels.slice(0, 200) : ['i', 'ii', '1', '2'];
  return result('viewer.page-labels', {
    method: 'local-viewer-logical-page-labels',
    labels,
    count: labels.length,
  });
}

export function viewerDocumentProperties(ctx = {}) {
  const { source, sourceSha256 } = admitSource(ctx);
  const title = typeof ctx.title === 'string' ? ctx.title : 'Untitled';
  return result('viewer.document-properties', {
    method: 'local-viewer-document-properties',
    sourceSha256,
    properties: Object.freeze({
      title,
      bytes: source.length,
      producer: 'platen-local',
      encrypted: source.toString('latin1').includes('/Encrypt'),
    }),
  });
}

export function viewerSelectCopy(ctx = {}) {
  const text = requireString(ctx.text ?? 'Selected region text', 'text', { min: 1, max: 100_000 });
  const selection = Object.freeze({
    text,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    charCount: text.length,
  });
  return result('viewer.select-copy', {
    method: 'local-viewer-selection-clipboard',
    selection,
    clipboardReady: true,
  });
}

export function viewerLoupe(ctx = {}) {
  const x = Number(ctx.x ?? 100);
  const y = Number(ctx.y ?? 100);
  const magnify = Number(ctx.magnify ?? 2);
  if (!(magnify >= 1 && magnify <= 16)) fail('INVALID_MAGNIFY', 'magnify 1..16', 400);
  return result('viewer.loupe', {
    method: 'local-viewer-loupe-region',
    region: Object.freeze({ x, y, magnify, width: 120, height: 120 }),
  });
}

export function viewerSnapshot(ctx = {}) {
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  const { sourceSha256 } = admitSource(ctx);
  const snapshotId = createHash('sha256').update(`${sourceSha256}|${page}|snap`).digest('hex').slice(0, 24);
  return result('viewer.snapshot', {
    method: 'local-viewer-page-snapshot-token',
    page,
    sourceSha256,
    snapshotId,
  });
}

export function viewerRulersGrid(ctx = {}) {
  const unit = ctx.unit === 'mm' || ctx.unit === 'in' ? ctx.unit : 'pt';
  const grid = Number(ctx.gridSpacing ?? 36);
  if (!(grid >= 1 && grid <= 288)) fail('INVALID_GRID', 'gridSpacing 1..288', 400);
  return result('viewer.rulers-grid', {
    method: 'local-viewer-rulers-and-grid',
    unit,
    gridSpacing: grid,
    rulersVisible: ctx.rulers !== false,
    gridVisible: ctx.grid !== false,
  });
}

export function viewerPresentationMode(ctx = {}) {
  return result('viewer.presentation-mode', {
    method: 'local-viewer-presentation-mode',
    presentation: true,
    chromeHidden: true,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
  });
}

export function viewerNavigationHistory(ctx = {}) {
  const history = Array.isArray(ctx.history)
    ? ctx.history.slice(0, 100)
    : [{ page: 1 }, { page: 3 }, { page: 2 }];
  const index = Number.isSafeInteger(ctx.index) ? ctx.index : history.length - 1;
  if (index < 0 || index >= history.length) fail('INVALID_HISTORY_INDEX', 'index out of range', 400);
  return result('viewer.navigation-history', {
    method: 'local-viewer-nav-history-stack',
    history,
    index,
    current: history[index],
    canBack: index > 0,
    canForward: index < history.length - 1,
  });
}

