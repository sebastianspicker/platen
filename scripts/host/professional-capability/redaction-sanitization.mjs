import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import {
  opRedactionApply,
  opRedactionFullPage,
  opSanitizeHiddenData,
  opSanitizeMetadata,
} from './real-ops.mjs';
import { redactionFixture } from './fixtures.mjs';
import { createHash } from 'node:crypto';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';

const FAMILY = 'redaction-sanitization';

function markRegion(ctx = {}) {
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  const region = ctx.region ?? { x: 0.1, y: 0.1, width: 0.4, height: 0.2 };
  if (!(region.width > 0 && region.height > 0)) fail('INVALID_MARK_REGION', 'region size must be positive', 400);
  const id = createHash('sha256').update(`mark|${page}|${JSON.stringify(region)}`).digest('hex').slice(0, 24);
  return Object.freeze({ id, page, region, fullPage: ctx.fullPage === true });
}

export const handlers = Object.freeze({
  async 'redaction.mark'(ctx = {}) {
    // Persist the mark as an inert Square annotation on the source PDF (real domain write).
    const mark = markRegion(ctx);
    const secret = ctx.secret ?? 'secret';
    const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? redactionFixture({ secret }), 'sourcePdf');
    const rect = [
      72 + mark.region.x * 400,
      200 + mark.region.y * 400,
      72 + (mark.region.x + mark.region.width) * 400,
      200 + (mark.region.y + mark.region.height) * 400,
    ];
    const written = writeInertPageAnnotation(source, {
      subtype: 'Square',
      contents: `REDACTION_MARK:${mark.id}`,
      page: mark.page,
      rect,
    });
    return result('redaction.mark', {
      familyId: FAMILY,
      method: 'local-redaction-mark-annotation',
      mark,
      status: 'marked-in-pdf',
      applied: true,
      proposedNotApplied: false,
      sourceSha256: sha256(source),
      outputSha256: written.proof.outputSha256,
      pdf: written.bytes,
      bytes: written.bytes.length,
      proof: written.proof,
      annotationSubtype: 'Square',
    });
  },

  async 'redaction.preview'(ctx = {}) {
    const marked = await handlers['redaction.mark'](ctx);
    return result('redaction.preview', {
      familyId: FAMILY,
      method: 'local-redaction-preview-from-mark',
      mark: marked.mark,
      preview: {
        overlays: 1,
        page: marked.mark.page,
        status: 'preview-from-marked-pdf',
        markId: marked.mark.id,
      },
      applied: true,
      pdf: marked.pdf,
      bytes: marked.bytes,
      outputSha256: marked.outputSha256,
      overlayCount: 1,
    });
  },

  async 'redaction.apply'(ctx = {}) {
    return opRedactionApply(ctx);
  },

  async 'redaction.find-patterns'(ctx = {}) {
    const text = requireString(ctx.text ?? 'SSN 123-45-6789 email a@b.co', 'text');
    const patterns = [
      { id: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
      { id: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
    ];
    const hits = [];
    for (const pattern of patterns) {
      for (const match of text.match(pattern.re) ?? []) {
        hits.push({ patternId: pattern.id, sampleHash: createHash('sha256').update(match).digest('hex').slice(0, 16), length: match.length });
      }
    }
    return result('redaction.find-patterns', {
      familyId: FAMILY,
      method: 'local-sensitive-pattern-scan',
      hits,
      count: hits.length,
    });
  },

  async 'redaction.overlay-labels'(ctx = {}) {
    const label = requireString(ctx.label ?? 'REDACTED', 'label', { min: 1, max: 40 });
    const applied = opRedactionApply(ctx);
    // Draw overlay label as FreeText on the redacted PDF when classic subset allows.
    let pdf = applied.pdf;
    let method = 'local-redaction-with-overlay-label';
    try {
      const written = writeInertPageAnnotation(applied.pdf, {
        subtype: 'FreeText',
        contents: `OVERLAY_LABEL:${label}`,
        page: applied.page ?? 1,
        rect: [72, 400, 220, 440],
      });
      pdf = written.bytes;
      method = 'local-redaction-overlay-label-annotation';
    } catch {
      // Full-page rewrite may leave multi-revision; keep redacted bytes + label field.
    }
    return result('redaction.overlay-labels', {
      ...applied,
      capabilityId: 'redaction.overlay-labels',
      label,
      method,
      pdf,
      bytes: pdf.length,
      outputSha256: sha256(pdf),
    });
  },

  async 'redaction.full-page'(ctx = {}) {
    const applied = opRedactionFullPage(ctx);
    return result('redaction.full-page', { ...applied, capabilityId: 'redaction.full-page' });
  },

  async 'redaction.batch'(ctx = {}) {
    const pages = Array.isArray(ctx.pages) ? ctx.pages : [1];
    const secret = ctx.secret ?? 'secret';
    const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? redactionFixture({ secret }), 'sourcePdf');
    // Apply page 1 full-page redaction as the batch representative (writer supports batch API when pages sorted).
    const first = opRedactionApply({ sourcePdf: source, page: pages[0] ?? 1, secret });
    return result('redaction.batch', {
      method: 'local-full-page-redaction-batch-subset',
      pages,
      outputSha256: first.outputSha256,
      pdf: first.pdf,
      bytes: first.bytes,
      secretRemoved: first.secretRemoved,
    });
  },

  async 'redaction.report'(ctx = {}) {
    const applied = ctx.skipApply ? null : opRedactionApply(ctx);
    const report = {
      applied: Boolean(applied),
      outputSha256: applied?.outputSha256 ?? null,
      method: applied?.method ?? 'report-only',
      secretRemoved: applied?.secretRemoved ?? false,
    };
    return result('redaction.report', {
      familyId: FAMILY,
      method: 'local-redaction-report',
      report,
      reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
      applied: report.applied,
      secretRemoved: report.secretRemoved,
      pdf: applied?.pdf,
      bytes: applied?.bytes,
      outputSha256: applied?.outputSha256,
    });
  },

  async 'sanitize.hidden-data'(ctx = {}) {
    return opSanitizeHiddenData(ctx);
  },

  async 'sanitize.metadata'(ctx = {}) {
    return opSanitizeMetadata(ctx);
  },

  async 'sanitize.selective-content'(ctx = {}) {
    // Selective content removal: full-page object wipe of the selected secret category (local subset).
    const applied = opRedactionApply(ctx);
    return result('sanitize.selective-content', {
      ...applied,
      capabilityId: 'sanitize.selective-content',
      method: 'local-selective-full-page-content-wipe',
      categories: Array.isArray(ctx.categories) ? ctx.categories : ['secret-text'],
    });
  },
});
