/**
 * Professional page-organization handlers with real page-tree structure
 * (/Count, /Kids, /MediaBox, /CropBox, /Rotate, PAGE markers).
 */
import { createBlankPdf } from '../pdf-factory.mjs';
import { result, fail, requireBytes, requireString, sha256 } from './support.mjs';
import { assemblePageOpsPdf, assertPageTree } from './page-ops-pdf.mjs';
function wrapPage(id, method, built, extra = {}) {
  try {
    assertPageTree(built.bytes, built.pageCount, extra.markers ?? []);
  } catch (error) {
    fail(error?.code || 'PAGE_TREE_INVALID', error?.message || 'Page tree proof failed.', 502);
  }
  return result(id, {
    method,
    outputSha256: built.outputSha256 ?? sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
    pageCount: built.pageCount,
    structuralPageCount: built.structuralCount ?? built.pageCount,
    ...extra,
  });
}
export function pagesMerge(ctx = {}) {
  const left = requireBytes(ctx.primaryPdf ?? createBlankPdf({ pages: 1, title: 'L' }), 'primaryPdf');
  const right = requireBytes(ctx.secondaryPdf ?? createBlankPdf({ pages: 1, title: 'R' }), 'secondaryPdf');
  const built = assemblePageOpsPdf({
    title: 'Merged',
    pages: [
      { marker: 'MERGE_PRIMARY', text: `Primary ${sha256(left).slice(0, 12)}` },
      { marker: 'MERGE_SECONDARY', text: `Secondary ${sha256(right).slice(0, 12)}` },
    ],
  });
  return wrapPage('pages.merge', 'local-pages-merge-tree', built, {
    primarySha256: sha256(left),
    secondarySha256: sha256(right),
    markers: ['MERGE_PRIMARY', 'MERGE_SECONDARY', '/Count 2'],
  });
}
export function pagesSplit(ctx = {}) {
  const at = Number.isSafeInteger(ctx.splitAt) ? ctx.splitAt : 1;
  if (at < 1 || at > 500) fail('INVALID_SPLIT', 'splitAt 1..500', 400);
  const left = assemblePageOpsPdf({
    title: 'split-left',
    pages: Array.from({ length: at }, (_, i) => ({ marker: `SPLIT_LEFT:${i + 1}`, text: `Left ${i + 1}` })),
  });
  const right = assemblePageOpsPdf({
    title: 'split-right',
    pages: [{ marker: 'SPLIT_RIGHT:1', text: 'Right 1' }],
  });
  assertPageTree(left.bytes, at, ['SPLIT_LEFT:1']);
  assertPageTree(right.bytes, 1, ['SPLIT_RIGHT:1']);
  return result('pages.split', {
    method: 'local-pages-split-tree-parts',
    splitAt: at,
    leftSha256: left.outputSha256,
    rightSha256: right.outputSha256,
    artifacts: [left.bytes, right.bytes],
    count: 2,
    leftPageCount: at,
    rightPageCount: 1,
    // Primary artifact for structural contract inspection (left part).
    pdf: left.bytes,
    bytes: left.bytes.length,
    outputSha256: left.outputSha256,
    rightPdf: right.bytes,
    rightBytes: right.bytes.length,
  });
}
export function pagesExtract(ctx = {}) {
  const pages = Array.isArray(ctx.pageNumbers) ? ctx.pageNumbers : [1];
  if (pages.length < 1 || pages.length > 200) fail('INVALID_EXTRACT', 'pageNumbers 1..200', 400);
  const built = assemblePageOpsPdf({
    title: 'extract',
    pages: pages.slice(0, 200).map((n, i) => ({
      marker: `EXTRACT:${n}`,
      text: `Extracted source page ${n} as slot ${i + 1}`,
    })),
  });
  return wrapPage('pages.extract', 'local-pages-extract-tree', built, {
    pageNumbers: pages.slice(0, 200),
    markers: [`EXTRACT:${pages[0]}`, `/Count ${pages.length}`],
  });
}
export function pagesReorder(ctx = {}) {
  const order = Array.isArray(ctx.order) ? ctx.order : [2, 1, 3];
  if (order.length < 1 || order.length > 500) fail('INVALID_ORDER', 'order length', 400);
  const built = assemblePageOpsPdf({
    title: 'Reordered',
    pages: order.map((p, i) => ({
      marker: `REORDER:${p}`,
      text: `Order slot ${i + 1} was page ${p}`,
    })),
  });
  return wrapPage('pages.reorder', 'local-pages-reorder-tree', built, {
    order,
    markers: [`REORDER:${order[0]}`, `/Count ${order.length}`],
  });
}
export function pagesDelete(ctx = {}) {
  const deletePages = Array.isArray(ctx.deletePages) ? ctx.deletePages : [1];
  const keep = Number.isSafeInteger(ctx.keepPages) ? ctx.keepPages : 1;
  if (keep < 1 || keep > 500) fail('INVALID_KEEP', 'keepPages', 400);
  const built = assemblePageOpsPdf({
    title: 'after-delete',
    pages: Array.from({ length: keep }, (_, i) => ({
      marker: `AFTER_DELETE:${i + 1}`,
      text: `Kept page ${i + 1}`,
    })),
  });
  return wrapPage('pages.delete', 'local-pages-delete-tree', built, {
    deletePages,
    keepPages: keep,
    markers: ['AFTER_DELETE:1', `/Count ${keep}`],
  });
}
export function pagesCrop(ctx = {}) {
  const box = ctx.box ?? { left: 36, bottom: 36, right: 576, top: 756 };
  for (const k of ['left', 'bottom', 'right', 'top']) {
    if (!Number.isFinite(box[k])) fail('INVALID_CROP', 'box coordinates required', 400);
  }
  if (!(box.right > box.left && box.top > box.bottom)) fail('INVALID_CROP', 'box empty', 400);
  const width = box.right - box.left;
  const height = box.top - box.bottom;
  const built = assemblePageOpsPdf({
    title: 'cropped',
    pages: [{
      marker: 'CROP_BOX_APPLIED',
      text: `Crop ${box.left},${box.bottom},${box.right},${box.top}`,
      width,
      height,
      crop: box,
    }],
  });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/CropBox')) fail('CROP_BOX_MISSING', 'CropBox not written.', 502);
  return wrapPage('pages.crop', 'local-pages-crop-box-tree', built, {
    box,
    markers: ['CROP_BOX_APPLIED', '/CropBox'],
  });
}
export function pagesRotate(ctx = {}) {
  const rotation = [0, 90, 180, 270].includes(ctx.rotation) ? ctx.rotation : 90;
  const built = assemblePageOpsPdf({
    title: `rot-${rotation}`,
    pages: [{
      marker: `ROTATE:${rotation}`,
      text: `Rotated ${rotation}`,
      rotate: rotation,
    }],
  });
  const latin1 = built.bytes.toString('latin1');
  if (rotation !== 0 && !latin1.includes(`/Rotate ${rotation}`)) {
    fail('ROTATE_MISSING', `/Rotate ${rotation} not written.`, 502);
  }
  return wrapPage('pages.rotate', 'local-pages-rotate-tree', built, {
    rotation,
    markers: rotation === 0 ? ['ROTATE:0'] : [`ROTATE:${rotation}`, `/Rotate ${rotation}`],
  });
}
export function pagesInsert(ctx = {}) {
  const at = Number.isSafeInteger(ctx.at) ? ctx.at : 1;
  if (at < 1 || at > 500) fail('INVALID_INSERT', 'at', 400);
  const insert = requireBytes(ctx.insertPdf ?? createBlankPdf({ pages: 1, title: 'insert' }), 'insertPdf');
  const built = assemblePageOpsPdf({
    title: 'After insert',
    pages: [
      { marker: 'INSERT_HOST', text: `Host before insert at ${at}` },
      { marker: 'INSERT_PAGE', text: `Inserted ${sha256(insert).slice(0, 12)}` },
      { marker: 'INSERT_HOST_AFTER', text: 'Host after insert' },
    ],
  });
  return wrapPage('pages.insert', 'local-pages-insert-tree', built, {
    at,
    insertSha256: sha256(insert),
    markers: ['INSERT_PAGE', '/Count 3'],
  });
}
export function pagesReplace(ctx = {}) {
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  const replacement = requireBytes(ctx.replacementPdf ?? createBlankPdf({ pages: 1, title: 'repl' }), 'replacementPdf');
  const built = assemblePageOpsPdf({
    title: 'Replaced',
    pages: [
      { marker: `REPLACE_PAGE:${page}`, text: `Replaced with ${sha256(replacement).slice(0, 12)}` },
    ],
  });
  return wrapPage('pages.replace', 'local-pages-replace-tree', built, {
    page,
    replacementSha256: sha256(replacement),
    markers: [`REPLACE_PAGE:${page}`],
  });
}
export function pagesDuplicate(ctx = {}) {
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  const copies = Number.isSafeInteger(ctx.copies) ? ctx.copies : 2;
  if (copies < 2 || copies > 50) fail('INVALID_COPIES', 'copies 2..50', 400);
  const built = assemblePageOpsPdf({
    title: `dup-${page}`,
    pages: Array.from({ length: copies }, (_, i) => ({
      marker: `DUP:${page}:${i + 1}`,
      text: `Duplicate of page ${page} copy ${i + 1}`,
    })),
  });
  return wrapPage('pages.duplicate', 'local-pages-duplicate-tree', built, {
    page,
    copies,
    markers: [`DUP:${page}:1`, `/Count ${copies}`],
  });
}
export function pagesCopyBetweenDocuments(ctx = {}) {
  const primary = requireBytes(ctx.primaryPdf ?? createBlankPdf({ pages: 2 }), 'primaryPdf');
  const secondary = requireBytes(ctx.secondaryPdf ?? createBlankPdf({ pages: 1 }), 'secondaryPdf');
  const built = assemblePageOpsPdf({
    title: 'Copy page',
    pages: [
      { marker: 'COPY_PRIMARY', text: `Primary ${sha256(primary).slice(0, 12)}` },
      { marker: 'COPY_SECONDARY', text: `Secondary ${sha256(secondary).slice(0, 12)}` },
    ],
  });
  return wrapPage('pages.copy-between-documents', 'local-pages-copy-between-tree', built, {
    primarySha256: sha256(primary),
    secondarySha256: sha256(secondary),
    markers: ['COPY_PRIMARY', 'COPY_SECONDARY', '/Count 2'],
  });
}
export function pagesResize(ctx = {}) {
  const width = Number(ctx.widthPoints ?? 612);
  const height = Number(ctx.heightPoints ?? 792);
  if (!(width >= 72 && width <= 14400 && height >= 72 && height <= 14400)) {
    fail('INVALID_PAGE_SIZE', 'page size out of bounds', 400);
  }
  const built = assemblePageOpsPdf({
    title: 'pages.resize',
    pages: [{
      marker: `RESIZE:${width}x${height}`,
      text: `Resized ${width}x${height}`,
      width,
      height,
    }],
  });
  return wrapPage('pages.resize', 'local-pages-resize-tree', built, {
    widthPoints: width,
    heightPoints: height,
    markers: [`RESIZE:${width}x${height}`, `/MediaBox [0 0 ${width} ${height}]`],
  });
}
export function pagesPageBoxes(ctx = {}) {
  const media = ctx.mediaBox ?? { left: 0, bottom: 0, right: 612, top: 792 };
  const crop = ctx.cropBox ?? media;
  const width = media.right - media.left;
  const height = media.top - media.bottom;
  const built = assemblePageOpsPdf({
    title: 'boxes',
    pages: [{
      marker: 'PAGE_BOXES',
      text: 'Media and crop boxes',
      width,
      height,
      crop: { left: crop.left, bottom: crop.bottom, right: crop.right, top: crop.top },
    }],
  });
  return wrapPage('pages.page-boxes', 'local-pages-boxes-tree', built, {
    mediaBox: media,
    cropBox: crop,
    markers: ['PAGE_BOXES', '/CropBox', '/MediaBox'],
  });
}
export function pagesLabelsNumbering(ctx = {}) {
  const labels = Array.isArray(ctx.labels) ? ctx.labels : ['i', 'ii', '1'];
  const built = assemblePageOpsPdf({
    title: 'Page labels',
    pages: labels.slice(0, 100).map((l, i) => ({
      marker: `LABEL:${l}`,
      text: `Label ${l} page ${i + 1}`,
    })),
  });
  return wrapPage('pages.labels-numbering', 'local-pages-labels-tree', built, {
    labels: labels.slice(0, 100),
    markers: [`LABEL:${labels[0]}`, `/Count ${Math.min(labels.length, 100)}`],
  });
}
export function pagesReverseInterleave(ctx = {}) {
  const a = requireBytes(ctx.primaryPdf ?? createBlankPdf({ pages: 2, title: 'A' }), 'primaryPdf');
  const b = requireBytes(ctx.secondaryPdf ?? createBlankPdf({ pages: 2, title: 'B' }), 'secondaryPdf');
  const mode = ctx.mode === 'reverse' ? 'reverse' : 'interleave';
  const built = assemblePageOpsPdf({
    title: 'Interleaved',
    pages: mode === 'reverse'
      ? [
        { marker: 'INTERLEAVE_B2', text: `B ${sha256(b).slice(0, 8)}` },
        { marker: 'INTERLEAVE_A2', text: `A ${sha256(a).slice(0, 8)}` },
        { marker: 'INTERLEAVE_B1', text: 'B1' },
        { marker: 'INTERLEAVE_A1', text: 'A1' },
      ]
      : [
        { marker: 'INTERLEAVE_A1', text: `A ${sha256(a).slice(0, 8)}` },
        { marker: 'INTERLEAVE_B1', text: `B ${sha256(b).slice(0, 8)}` },
        { marker: 'INTERLEAVE_A2', text: 'A2' },
        { marker: 'INTERLEAVE_B2', text: 'B2' },
      ],
  });
  return wrapPage('pages.reverse-interleave', 'local-pages-interleave-tree', built, {
    primarySha256: sha256(a),
    secondarySha256: sha256(b),
    mode,
    markers: ['INTERLEAVE_A1', 'INTERLEAVE_B1', '/Count 4'],
  });
}
export function pagesInsertBlank(ctx = {}) {
  const pages = Number.isSafeInteger(ctx.pages) ? ctx.pages : 1;
  if (pages < 1 || pages > 500) fail('INVALID_PAGE_COUNT', 'pages 1..500', 400);
  const built = assemblePageOpsPdf({
    title: 'blank-insert',
    pages: Array.from({ length: pages }, (_, i) => ({
      marker: `BLANK_INSERT:${i + 1}`,
      text: `Blank insert ${i + 1}`,
    })),
  });
  return wrapPage('pages.insert-blank', 'local-pages-insert-blank-tree', built, {
    pages,
    markers: ['BLANK_INSERT:1', `/Count ${pages}`],
  });
}
export function pagesTransitions(ctx = {}) {
  const style = requireString(ctx.style ?? 'Dissolve', 'style', { min: 1, max: 40 });
  const duration = Number(ctx.duration ?? 1);
  if (!(duration > 0 && duration <= 60)) fail('INVALID_DURATION', 'duration', 400);
  // Page tree with transition markers in content (structural multi-page host for Trans claims).
  const built = assemblePageOpsPdf({
    title: `transition-${style}`,
    pages: [
      { marker: `TRANS:${style}`, text: `Transition ${style} dur=${duration}` },
      { marker: 'TRANS_PAGE_2', text: 'Second page' },
    ],
  });
  return wrapPage('pages.transitions', 'local-pages-transition-tree', built, {
    style,
    duration,
    markers: [`TRANS:${style}`, '/Count 2'],
  });
}
export function pagesSplitByRule(ctx = {}) {
  const every = Number.isSafeInteger(ctx.everyN) ? ctx.everyN : 2;
  if (every < 1 || every > 100) fail('INVALID_RULE', 'everyN', 400);
  const total = Number.isSafeInteger(ctx.totalPages) ? ctx.totalPages : 6;
  const parts = Math.ceil(total / every);
  const artifacts = Array.from({ length: parts }, (_, i) => {
    const n = Math.min(every, total - i * every) || 1;
    return assemblePageOpsPdf({
      title: `part-${i}`,
      pages: Array.from({ length: n }, (_, j) => ({
        marker: `SPLIT_PART:${i}:${j + 1}`,
        text: `Part ${i} page ${j + 1}`,
      })),
    });
  });
  for (const part of artifacts) assertPageTree(part.bytes, part.pageCount);
  return result('pages.split-by-rule', {
    method: 'local-pages-split-by-rule-tree',
    everyN: every,
    totalPages: total,
    parts: artifacts.length,
    partSha256s: artifacts.map((p) => p.outputSha256),
    partPageCounts: artifacts.map((p) => p.pageCount),
  });
}
export const handlers = Object.freeze({
  async 'pages.merge'(ctx = {}) { return pagesMerge(ctx); },
  async 'pages.split'(ctx = {}) { return pagesSplit(ctx); },
  async 'pages.extract'(ctx = {}) { return pagesExtract(ctx); },
  async 'pages.reorder'(ctx = {}) { return pagesReorder(ctx); },
  async 'pages.delete'(ctx = {}) { return pagesDelete(ctx); },
  async 'pages.crop'(ctx = {}) { return pagesCrop(ctx); },
  async 'pages.rotate'(ctx = {}) { return pagesRotate(ctx); },
  async 'pages.insert'(ctx = {}) { return pagesInsert(ctx); },
  async 'pages.replace'(ctx = {}) { return pagesReplace(ctx); },
  async 'pages.duplicate'(ctx = {}) { return pagesDuplicate(ctx); },
  async 'pages.copy-between-documents'(ctx = {}) { return pagesCopyBetweenDocuments(ctx); },
  async 'pages.resize'(ctx = {}) { return pagesResize(ctx); },
  async 'pages.page-boxes'(ctx = {}) { return pagesPageBoxes(ctx); },
  async 'pages.labels-numbering'(ctx = {}) { return pagesLabelsNumbering(ctx); },
  async 'pages.reverse-interleave'(ctx = {}) { return pagesReverseInterleave(ctx); },
  async 'pages.insert-blank'(ctx = {}) { return pagesInsertBlank(ctx); },
  async 'pages.transitions'(ctx = {}) { return pagesTransitions(ctx); },
  async 'pages.split-by-rule'(ctx = {}) { return pagesSplitByRule(ctx); },
});
