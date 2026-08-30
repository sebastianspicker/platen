import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import { formFixture } from './fixtures.mjs';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';
import {
  reviewAnnotationFlatten,
} from './annotations-review-extra.mjs';
export {
  reviewAnnotationFlatten,
} from './annotations-review-extra.mjs';

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

export const handlers = Object.freeze({
  async 'review.custom-stamps'(ctx = {}) { return reviewCustomStamps(ctx); },
  async 'review.annotation-flatten'(ctx = {}) { return reviewAnnotationFlatten(ctx); },
});
