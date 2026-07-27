import { result, requireString } from './support.mjs';
import { opCompareContent } from './real-ops.mjs';
import { diffTokens } from '../comparison-algorithms.mjs';
import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import { sha256 } from './support.mjs';

const FAMILY = 'comparison';

export const handlers = Object.freeze({
  async 'compare.content'(ctx = {}) { return opCompareContent(ctx); },

  async 'compare.pixel'(ctx = {}) {
    // Pixel compare on synthetic rasters via exact buffer equality.
    const left = Buffer.from(ctx.leftPixels ?? Buffer.alloc(16, 1));
    const right = Buffer.from(ctx.rightPixels ?? Buffer.alloc(16, 2));
    const equal = left.equals(right);
    let differingBytes = 0;
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i += 1) if (left[i] !== right[i]) differingBytes += 1;
    differingBytes += Math.abs(left.length - right.length);
    return result('compare.pixel', {
      familyId: FAMILY,
      method: 'local-pixel-buffer-compare',
      equal,
      differingBytes,
      leftSha256: createHash('sha256').update(left).digest('hex'),
      rightSha256: createHash('sha256').update(right).digest('hex'),
    });
  },

  async 'compare.overlay'(ctx = {}) {
    const content = opCompareContent(ctx);
    return result('compare.overlay', {
      familyId: FAMILY,
      method: 'local-overlay-compare-binding',
      base: 'left',
      overlay: 'right',
      contentChanged: content.changed,
      stats: content.stats,
    });
  },

  async 'compare.side-by-side'(ctx = {}) {
    const content = opCompareContent(ctx);
    return result('compare.side-by-side', {
      familyId: FAMILY,
      method: 'local-side-by-side-compare-binding',
      left: content.left,
      right: content.right,
      stats: content.stats,
    });
  },

  async 'compare.annotations'(ctx = {}) {
    const left = Array.isArray(ctx.left) ? ctx.left : [{ type: 'Highlight', page: 1 }];
    const right = Array.isArray(ctx.right) ? ctx.right : [{ type: 'Highlight', page: 1 }, { type: 'Text', page: 2 }];
    const leftKeys = new Set(left.map((a) => `${a.type}|${a.page}`));
    const rightKeys = new Set(right.map((a) => `${a.type}|${a.page}`));
    const onlyLeft = [...leftKeys].filter((k) => !rightKeys.has(k));
    const onlyRight = [...rightKeys].filter((k) => !leftKeys.has(k));
    return result('compare.annotations', {
      familyId: FAMILY,
      method: 'local-annotation-set-compare',
      onlyLeft,
      onlyRight,
      changed: onlyLeft.length + onlyRight.length > 0,
    });
  },

  async 'compare.cross-format'(ctx = {}) {
    const left = requireString(ctx.leftText ?? 'alpha', 'leftText');
    const right = requireString(ctx.rightText ?? 'alpha', 'rightText');
    const diff = diffTokens(left, right);
    return result('compare.cross-format', {
      familyId: FAMILY,
      method: 'local-cross-format-text-compare',
      stats: diff.stats,
      changed: (diff.stats.added + diff.stats.deleted) > 0,
    });
  },

  async 'compare.batch'(ctx = {}) {
    const pairs = Array.isArray(ctx.pairs) ? ctx.pairs : [
      { leftText: 'a b', rightText: 'a c' },
      { leftText: 'x', rightText: 'x' },
    ];
    const results = pairs.slice(0, 50).map((pair, index) => {
      const diff = diffTokens(pair.leftText ?? '', pair.rightText ?? '');
      return { index, stats: diff.stats, changed: diff.stats.added + diff.stats.deleted > 0 };
    });
    return result('compare.batch', {
      familyId: FAMILY,
      method: 'local-batch-content-compare',
      results,
      count: results.length,
    });
  },

  async 'compare.report-export'(ctx = {}) {
    const content = opCompareContent(ctx);
    const report = {
      kind: 'comparison-report',
      stats: content.stats,
      runs: content.runs,
      changed: content.changed,
    };
    const json = JSON.stringify(report);
    return result('compare.report-export', {
      familyId: FAMILY,
      method: 'local-comparison-report-json',
      json,
      reportSha256: createHash('sha256').update(json).digest('hex'),
      stats: content.stats,
    });
  },

  async 'compare.package'(ctx = {}) {
    const content = opCompareContent(ctx);
    const pdf = createTextPdf({
      text: `Comparison package\nchanged=${content.changed}\nadded=${content.stats.added}\ndeleted=${content.stats.deleted}`,
      title: 'Comparison package',
    });
    return result('compare.package', {
      familyId: FAMILY,
      method: 'local-comparison-package-pdf',
      outputSha256: sha256(pdf),
      pdf,
      bytes: pdf.length,
      stats: content.stats,
    });
  },
});
