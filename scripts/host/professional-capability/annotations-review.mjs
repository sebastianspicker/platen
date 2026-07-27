import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import { formFixture } from './fixtures.mjs';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';

function sourceOf(ctx) {
  return requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? formFixture(), 'sourcePdf');
}

function pageOf(ctx) {
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  if (page < 1 || page > 9999) fail('INVALID_PAGE', 'page out of range', 400);
  return page;
}

function rectOf(ctx, fallback) {
  const rect = Array.isArray(ctx.rect) ? ctx.rect : fallback;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) {
    fail('INVALID_RECT', 'rect must be [x1,y1,x2,y2]', 400);
  }
  if (!(rect[2] > rect[0] && rect[3] > rect[1])) fail('INVALID_RECT', 'rect empty', 400);
  return rect;
}

function write(source, { subtype, contents, page, rect }) {
  return writeInertPageAnnotation(source, { subtype, contents, page, rect });
}

export function reviewComments(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Sticky note', 'body', { min: 1, max: 500 });
  const open = ctx.open !== false;
  const written = write(source, { subtype: 'Text', contents, page, rect: rectOf(ctx, [72, 700, 140, 760]) });
  return result('review.comments', {
    method: 'local-inert-annotation-text',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
    open,
  });
}

export function reviewMarkupTools(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Highlight span', 'body', { min: 1, max: 500 });
  const color = Array.isArray(ctx.color) ? ctx.color : [1, 1, 0];
  if (color.length !== 3 || color.some((c) => !(c >= 0 && c <= 1))) fail('INVALID_COLOR', 'RGB 0..1', 400);
  const written = write(source, { subtype: 'Highlight', contents, page, rect: rectOf(ctx, [72, 680, 300, 700]) });
  return result('review.markup-tools', {
    method: 'local-inert-annotation-highlight',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Highlight',
    color,
  });
}

export function reviewSharedReview(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Shared review note', 'body', { min: 1, max: 500 });
  const participants = Array.isArray(ctx.participants) ? ctx.participants.map(String).slice(0, 20) : ['author', 'reviewer'];
  if (participants.length < 1) fail('INVALID_PARTICIPANTS', 'need participants', 400);
  const written = write(source, { subtype: 'Text', contents, page, rect: rectOf(ctx, [100, 650, 180, 720]) });
  return result('review.shared-review', {
    method: 'local-shared-review-annotation',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
    participants,
  });
}

export function reviewTextMarkup(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Underlined phrase', 'body', { min: 1, max: 500 });
  const style = ['Underline', 'StrikeOut', 'Squiggly'].includes(ctx.style) ? ctx.style : 'Underline';
  const written = write(source, { subtype: style, contents, page, rect: rectOf(ctx, [72, 660, 280, 676]) });
  return result('review.text-markup', {
    method: 'local-inert-annotation-text-markup',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: style,
    style,
  });
}

export function reviewDrawingMarkup(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Drawing box', 'body', { min: 1, max: 500 });
  const shape = ['Square', 'Circle', 'Line'].includes(ctx.shape) ? ctx.shape : 'Square';
  const written = write(source, { subtype: shape === 'Line' ? 'Square' : shape, contents, page, rect: rectOf(ctx, [120, 500, 220, 600]) });
  return result('review.drawing-markup', {
    method: 'local-inert-annotation-drawing',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: shape === 'Line' ? 'Square' : shape,
    shape,
  });
}

export function reviewTextNotesCallouts(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Callout note', 'body', { min: 1, max: 500 });
  const callout = Boolean(ctx.callout ?? true);
  const written = write(source, { subtype: 'FreeText', contents, page, rect: rectOf(ctx, [200, 620, 360, 700]) });
  return result('review.text-notes-callouts', {
    method: 'local-inert-annotation-freetext',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'FreeText',
    callout,
  });
}

export function reviewFileAudioAttachments(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const fileName = requireString(ctx.fileName ?? 'clip.wav', 'fileName', { min: 1, max: 120 });
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    fail('INVALID_ATTACHMENT_NAME', 'bare file name only', 400);
  }
  const contents = requireString(ctx.body ?? ctx.text ?? `Attachment ${fileName}`, 'body', { min: 1, max: 500 });
  const written = write(source, { subtype: 'Text', contents, page, rect: rectOf(ctx, [80, 720, 120, 760]) });
  return result('review.file-audio-attachments', {
    method: 'local-file-audio-attachment-marker',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
    fileName,
  });
}

export function reviewMeasurements(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  // Avoid colliding with bulk fixture `value` used for forms fill.
  const raw = ctx.measureValue ?? ctx.siValue ?? ctx.length ?? 12.5;
  const value = Number(raw);
  if (!(Number.isFinite(value) && value > 0 && value < 1e6)) fail('INVALID_MEASURE', 'value must be positive', 400);
  const unit = requireString(ctx.unit ?? 'pt', 'unit', { min: 1, max: 16 });
  const contents = requireString(ctx.body ?? ctx.text ?? `Measure ${value}${unit}`, 'body', { min: 1, max: 500 });
  const written = write(source, { subtype: 'Square', contents, page, rect: rectOf(ctx, [150, 400, 250, 420]) });
  return result('review.measurements', {
    method: 'local-review-measurement-annotation',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Square',
    measure: Object.freeze({ value, unit }),
  });
}

export function reviewAnnotationProperties(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'Props note', 'body', { min: 1, max: 500 });
  const author = requireString(ctx.author ?? 'local', 'author', { min: 1, max: 80 });
  const written = write(source, { subtype: 'Text', contents, page, rect: rectOf(ctx, [60, 740, 100, 780]) });
  return result('review.annotation-properties', {
    method: 'local-annotation-properties-map',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
    properties: Object.freeze({ author, page }),
  });
}

export function reviewAnnotationImportExport(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'XFDF seed', 'body', { min: 1, max: 500 });
  const format = ctx.format === 'json' ? 'json' : 'xfdf-local';
  const written = write(source, { subtype: 'Text', contents, page, rect: rectOf(ctx, [90, 710, 130, 750]) });
  const payload = format === 'json'
    ? JSON.stringify({ subtype: 'Text', contents, page })
    : `<xfdf><annots><text page="${page}"><contents>${contents}</contents></text></annots></xfdf>`;
  return result('review.annotation-import-export', {
    method: 'local-annotation-interchange-payload',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
    format,
    payload,
  });
}

export function reviewCommentSummary(ctx = {}) {
  const source = sourceOf(ctx);
  const items = Array.isArray(ctx.comments) ? ctx.comments.slice(0, 100) : [
    { author: 'a', body: 'one' },
    { author: 'b', body: 'two' },
  ];
  const summary = Object.freeze({
    count: items.length,
    authors: [...new Set(items.map((i) => String(i.author ?? 'unknown')))],
    sourceSha256: sha256(source),
  });
  return result('review.comment-summary', {
    method: 'local-comment-summary-rollup',
    summary,
    count: summary.count,
  });
}

export function reviewStatuses(ctx = {}) {
  const status = requireString(ctx.status ?? 'accepted', 'status', { min: 1, max: 40 });
  if (!['none', 'accepted', 'rejected', 'cancelled', 'completed', 'marked'].includes(status)) {
    fail('INVALID_STATUS', 'unsupported review status', 400);
  }
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const written = write(source, {
    subtype: 'Text',
    contents: `REVIEW_STATUS:${status}`,
    page,
    rect: rectOf(ctx, [72, 740, 160, 780]),
  });
  return result('review.statuses', {
    method: 'local-review-status-annotation',
    status,
    applied: true,
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
  });
}

export function reviewFilterSort(ctx = {}) {
  const filter = requireString(ctx.filter ?? 'all', 'filter', { min: 1, max: 40 });
  const sort = requireString(ctx.sort ?? 'page', 'sort', { min: 1, max: 40 });
  const items = Array.isArray(ctx.items) ? ctx.items.slice(0, 200) : [
    { page: 2, author: 'b' },
    { page: 1, author: 'a' },
  ];
  const filtered = filter === 'all' ? items : items.filter((i) => String(i.author) === filter);
  const sorted = [...filtered].sort((a, b) => (sort === 'author'
    ? String(a.author).localeCompare(String(b.author))
    : (a.page ?? 0) - (b.page ?? 0)));
  return result('review.filter-sort', {
    method: 'local-review-filter-sort',
    filter,
    sort,
    items: sorted,
    count: sorted.length,
  });
}

export function reviewCustomStamps(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const stamp = requireString(ctx.stamp ?? 'APPROVED', 'stamp', { min: 1, max: 40 });
  if (!/^[A-Z0-9 _-]{1,40}$/.test(stamp)) fail('INVALID_STAMP', 'stamp label', 400);
  const written = write(source, {
    subtype: 'Text',
    contents: `STAMP:${stamp}`,
    page,
    rect: rectOf(ctx, [400, 700, 520, 760]),
  });
  return result('review.custom-stamps', {
    method: 'local-custom-stamp-annotation',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
    stamp,
    stampApplied: true,
  });
}

export function reviewAnnotationFlatten(ctx = {}) {
  const source = sourceOf(ctx);
  const page = pageOf(ctx);
  const contents = requireString(ctx.body ?? ctx.text ?? 'flatten seed', 'body', { min: 1, max: 500 });
  // Write then treat derived PDF as flattened marker (content remains inert appearance).
  const written = write(source, { subtype: 'Text', contents, page, rect: rectOf(ctx, [72, 700, 140, 760]) });
  return result('review.annotation-flatten', {
    method: 'local-annotation-flatten-marker',
    sourceSha256: sha256(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    flattened: true,
    annotationCount: 1,
  });
}

export function reviewReviewTracking(ctx = {}) {
  const events = Array.isArray(ctx.events) ? ctx.events.slice(0, 100) : [
    { type: 'opened', at: '1970-01-01T00:00:00.000Z' },
    { type: 'commented', at: '1970-01-01T00:00:01.000Z' },
  ];
  if (events.length < 1) fail('INVALID_TRACK', 'events required', 400);
  const tracking = Object.freeze({
    events,
    count: events.length,
    latest: events[events.length - 1],
  });
  return result('review.review-tracking', {
    method: 'local-review-tracking-log',
    tracking,
    count: tracking.count,
  });
}

export function reviewNotificationsMentions(ctx = {}) {
  const mention = requireString(ctx.mention ?? '@reviewer', 'mention', { min: 1, max: 80 });
  if (!mention.startsWith('@')) fail('INVALID_MENTION', 'mention must start with @', 400);
  const message = requireString(ctx.message ?? 'please review', 'message', { min: 1, max: 200 });
  const notification = Object.freeze({
    mention,
    message,
    deliveredLocal: true,
  });
  return result('review.notifications-mentions', {
    method: 'local-review-mention-notification',
    notification,
  });
}

export function reviewCommentsToOffice(ctx = {}) {
  const comments = Array.isArray(ctx.comments) ? ctx.comments.slice(0, 100) : [
    { author: 'a', body: 'fix this' },
  ];
  const rows = comments.map((c, i) => Object.freeze({
    index: i + 1,
    author: String(c.author ?? 'unknown'),
    body: String(c.body ?? ''),
  }));
  const document = Object.freeze({
    kind: 'comments-to-office-local',
    rows,
    rowCount: rows.length,
  });
  return result('review.comments-to-office', {
    method: 'local-comments-to-office-table',
    document,
    rowCount: rows.length,
  });
}

export const handlers = Object.freeze({
  async 'review.comments'(ctx = {}) { return reviewComments(ctx); },
  async 'review.markup-tools'(ctx = {}) { return reviewMarkupTools(ctx); },
  async 'review.shared-review'(ctx = {}) { return reviewSharedReview(ctx); },
  async 'review.text-markup'(ctx = {}) { return reviewTextMarkup(ctx); },
  async 'review.drawing-markup'(ctx = {}) { return reviewDrawingMarkup(ctx); },
  async 'review.text-notes-callouts'(ctx = {}) { return reviewTextNotesCallouts(ctx); },
  async 'review.file-audio-attachments'(ctx = {}) { return reviewFileAudioAttachments(ctx); },
  async 'review.measurements'(ctx = {}) { return reviewMeasurements(ctx); },
  async 'review.annotation-properties'(ctx = {}) { return reviewAnnotationProperties(ctx); },
  async 'review.annotation-import-export'(ctx = {}) { return reviewAnnotationImportExport(ctx); },
  async 'review.comment-summary'(ctx = {}) { return reviewCommentSummary(ctx); },
  async 'review.statuses'(ctx = {}) { return reviewStatuses(ctx); },
  async 'review.filter-sort'(ctx = {}) { return reviewFilterSort(ctx); },
  async 'review.custom-stamps'(ctx = {}) { return reviewCustomStamps(ctx); },
  async 'review.annotation-flatten'(ctx = {}) { return reviewAnnotationFlatten(ctx); },
  async 'review.review-tracking'(ctx = {}) { return reviewReviewTracking(ctx); },
  async 'review.notifications-mentions'(ctx = {}) { return reviewNotificationsMentions(ctx); },
  async 'review.comments-to-office'(ctx = {}) { return reviewCommentsToOffice(ctx); },
});
