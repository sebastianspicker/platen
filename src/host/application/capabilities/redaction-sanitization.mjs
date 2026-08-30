import { result, requireBytes, sha256, fail } from './support.mjs';
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

  async 'redaction.apply'(ctx = {}) {
    return opRedactionApply(ctx);
  },

  async 'redaction.full-page'(ctx = {}) {
    const applied = opRedactionFullPage(ctx);
    return result('redaction.full-page', { ...applied, capabilityId: 'redaction.full-page' });
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

});
