import { result, requireString, fail } from './support.mjs';

export async function reviewAnnotationFlatten(ctx = {}) {
  if (typeof ctx.annotationFlatten?.flatten !== 'function'
    || typeof ctx.documentId !== 'string' || ctx.documentId.length === 0
    || typeof ctx.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(ctx.sourceSha256)) {
    fail('ANNOTATION_FLATTEN_UNAVAILABLE', 'Annotation flattening requires the validated source-bound flatten service.', 503);
  }
  if (!ctx.flattenRequest || typeof ctx.flattenRequest !== 'object' || Array.isArray(ctx.flattenRequest)) {
    fail('INVALID_ANNOTATION_FLATTEN_REQUEST', 'flattenRequest is required.', 400);
  }
  const flattened = await ctx.annotationFlatten.flatten(
    ctx.documentId,
    ctx.flattenRequest,
    { sourceSha256: ctx.sourceSha256, signal: ctx.signal },
  );
  const valid = flattened?.kind === 'pdf-square-annotation-flatten'
    && flattened.sourceDigest === ctx.sourceSha256
    && flattened.artifact && typeof flattened.artifact.id === 'string'
    && flattened.flatten?.profile === ctx.flattenRequest.profile
    && flattened.flatten?.page === ctx.flattenRequest.target?.page
    && flattened.flatten?.annotationIndex === ctx.flattenRequest.target?.annotationIndex
    && flattened.flatten?.subtype === 'square'
    && flattened.evidence?.appearancePromotedToPageContent === true
    && flattened.evidence?.annotationRemoved === true
    && flattened.evidence?.removedReferenceUnresolvable === true
    && flattened.evidence?.pageValidationRendersMatched === true
    && flattened.evidence?.artifactDigestBound === true
    && flattened.evidence?.sourceUnchanged === true;
  if (!valid) fail('ANNOTATION_FLATTEN_OUTPUT_INVALID', 'Validated annotation flatten service returned an incoherent receipt.', 502);
  return result('review.annotation-flatten', {
    method: 'validated-square-annotation-flatten-service',
    sourceDigest: flattened.sourceDigest,
    artifactId: flattened.artifact.id,
    flatten: flattened.flatten,
    evidence: flattened.evidence,
    limitations: flattened.limitations,
    flattened: true,
    annotationCount: 1,
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
