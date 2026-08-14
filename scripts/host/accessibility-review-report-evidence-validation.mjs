import { ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS } from './accessibility-review-check-contract.mjs';

const ROLE = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;
const STATUSES = Object.freeze(['pass', 'warning', 'fail', 'not-checked']);
const CHECK_IDS = Object.freeze(Object.keys(ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS));
const EVIDENCE_ID = /^[a-z][a-z0-9.-]{0,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EVIDENCE_KEYS = Object.freeze([
  'fonts', 'images', 'urls', 'imageTargets',
  'unicodeFonts', 'nonUnicodeFonts', 'unknownUnicodeFonts',
  'embeddedFonts', 'nonEmbeddedFonts', 'unknownEmbeddedFonts',
  'emptyExtractedTextPages', 'tagRoles', 'optionalPdfKit', 'sources',
]);
const COUNT_EVIDENCE_KEYS = Object.freeze([
  'fonts', 'images', 'urls', 'unicodeFonts', 'nonUnicodeFonts',
  'unknownUnicodeFonts', 'embeddedFonts', 'nonEmbeddedFonts',
  'unknownEmbeddedFonts', 'emptyExtractedTextPages',
]);
const ROLE_KEYS = Object.freeze([
  'recordCount', 'roleCounts', 'unknownRoleCount', 'hierarchyCoverage',
  'malformedDepthTransitionCount', 'headingCount', 'headingSequenceViolation',
  'invalidListRelationshipCount', 'unknownListRelationshipCount',
  'invalidTableRelationshipCount', 'unknownTableRelationshipCount',
]);
const OPTIONAL_PDFKIT_KEYS = new Set([
  'attempted', 'available', 'unavailableReason', 'contentAccessibility',
  'permissionStatus', 'widgetCount', 'unnamedWidgetCount', 'widgetsTruncated',
  'outlineItemCount', 'outlineTruncated',
]);
const BASE_SOURCE_IDS = Object.freeze([
  'poppler.pdfinfo', 'poppler.pdfinfo-struct', 'poppler.pdfinfo-meta',
  'poppler.pdfinfo-custom', 'poppler.pdfinfo-url', 'poppler.pdffonts',
  'poppler.pdfimages-list', 'poppler.pdftotext-layout',
  'review-profile.capability-boundary',
]);
const PDFKIT_SOURCE_IDS = Object.freeze([
  'apple-pdfkit.inventory', 'apple-pdfkit.outline-inventory',
  'apple-pdfkit.document-permissions',
]);

function exact(value, keys, label, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} must contain the exact required fields.`);
  }
}

function boundedInteger(value, maximum = 50_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateChecks(report, fail) {
  exact(report.counts, STATUSES, 'Accessibility review counts', fail);
  if (!Array.isArray(report.checks) || report.checks.length !== CHECK_IDS.length) {
    fail('The accessibility review must contain the fixed check set.');
  }
  for (const [index, check] of report.checks.entries()) {
    exact(check, ['id', 'status', 'summary', 'evidenceRefs'], 'Accessibility review check', fail);
    const expectedId = CHECK_IDS[index];
    const expectedRefs = ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS[expectedId];
    if (check.id !== expectedId || !STATUSES.includes(check.status)
      || typeof check.summary !== 'string' || check.summary.length < 1
      || check.summary.length > 240 || Buffer.byteLength(check.summary) > 960
      || !Array.isArray(check.evidenceRefs) || check.evidenceRefs.length !== expectedRefs.length
      || check.evidenceRefs.some((reference, referenceIndex) => reference !== expectedRefs[referenceIndex])) {
      fail('The accessibility review check set does not match the fixed profile.');
    }
  }
  for (const status of STATUSES) {
    if (!boundedInteger(report.counts[status], 19)
      || report.counts[status] !== report.checks.filter((check) => check.status === status).length) {
      fail('The accessibility review counts do not match its checks.');
    }
  }
  const expectedStatus = report.counts.fail ? 'fail' : 'review-required';
  if (report.status !== expectedStatus) fail('The accessibility review status does not match its checks.');
}

function validateTagRoles(tagRoles, fail) {
  exact(tagRoles, ROLE_KEYS, 'Accessibility tag-role evidence', fail);
  if (!tagRoles.roleCounts || typeof tagRoles.roleCounts !== 'object' || Array.isArray(tagRoles.roleCounts)) {
    fail('Accessibility tag-role counts must be an object.');
  }
  exact(tagRoles.roleCounts, Object.keys(tagRoles.roleCounts), 'Accessibility tag-role counts', fail);
  const countKeys = Object.keys(tagRoles.roleCounts);
  if (countKeys.length > 64 || countKeys.some((key) => !ROLE.test(key) || !boundedInteger(tagRoles.roleCounts[key]))) {
    fail('Accessibility tag-role counts are invalid.');
  }
  for (const key of ROLE_KEYS.filter((key) => key.endsWith('Count'))) {
    if (!boundedInteger(tagRoles[key])) fail('Accessibility tag-role evidence counts are invalid.');
  }
  if (!['complete', 'unknown'].includes(tagRoles.hierarchyCoverage)
    || typeof tagRoles.headingSequenceViolation !== 'boolean') {
    fail('Accessibility tag-role evidence is invalid.');
  }
}

function validateOptionalPdfKit(value, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Optional PDFKit evidence is invalid.');
  const keys = Object.keys(value);
  if (!Object.hasOwn(value, 'attempted') || !Object.hasOwn(value, 'available')
    || keys.some((key) => !OPTIONAL_PDFKIT_KEYS.has(key))
    || typeof value.attempted !== 'boolean' || typeof value.available !== 'boolean') {
    fail('Optional PDFKit evidence has an invalid shape.');
  }
  if (Object.hasOwn(value, 'unavailableReason') && value.unavailableReason !== 'document-unsupported') {
    fail('Optional PDFKit unavailable evidence is invalid.');
  }
  if (!value.available) {
    if (keys.some((key) => !['attempted', 'available', 'unavailableReason'].includes(key))
      || (value.unavailableReason === 'document-unsupported') !== value.attempted) {
      fail('Unavailable PDFKit evidence has an invalid state.');
    }
    return;
  }
  if (!value.attempted || Object.hasOwn(value, 'unavailableReason')) fail('Available PDFKit evidence has an invalid state.');
  for (const key of ['contentAccessibility', 'permissionStatus', 'widgetCount', 'unnamedWidgetCount', 'widgetsTruncated', 'outlineItemCount', 'outlineTruncated']) {
    if (!Object.hasOwn(value, key)) fail('Available PDFKit evidence is incomplete.');
  }
  if (value.contentAccessibility !== null && typeof value.contentAccessibility !== 'boolean'
    || !['none', 'user', 'owner', 'unknown'].includes(value.permissionStatus)
    || !boundedInteger(value.widgetCount, 5_000) || !boundedInteger(value.unnamedWidgetCount, 5_000)
    || !boundedInteger(value.outlineItemCount, 200) || typeof value.widgetsTruncated !== 'boolean'
    || typeof value.outlineTruncated !== 'boolean') {
    fail('Available PDFKit evidence is invalid.');
  }
}

function validateSources(sources, attempted, fail) {
  const expectedIds = attempted ? [...BASE_SOURCE_IDS, ...PDFKIT_SOURCE_IDS] : BASE_SOURCE_IDS;
  if (!Array.isArray(sources) || sources.length !== expectedIds.length) fail('Accessibility evidence sources are incomplete.');
  for (const [index, source] of sources.entries()) {
    exact(source, ['id', 'version', 'versionStatus'], 'Accessibility evidence source', fail);
    if (typeof source.id !== 'string' || !EVIDENCE_ID.test(source.id)
      || source.version !== null && typeof source.version !== 'string'
      || typeof source.version === 'string' && source.version.length > 32
      || !['recorded', 'not-recorded-in-report', 'helper-version-not-recorded-in-report'].includes(source.versionStatus)) {
      fail('Accessibility evidence source metadata is invalid.');
    }
    const expectedId = expectedIds[index];
    const expectedVersion = source.id === 'review-profile.capability-boundary' ? '3' : null;
    const expectedStatus = source.id === 'review-profile.capability-boundary' ? 'recorded'
      : source.id.startsWith('apple-pdfkit.') ? 'helper-version-not-recorded-in-report' : 'not-recorded-in-report';
    if (source.id !== expectedId) fail('Accessibility evidence sources are not in the fixed profile order.');
    if (source.version !== expectedVersion || source.versionStatus !== expectedStatus) {
      fail('Accessibility evidence source version metadata is invalid.');
    }
  }
}

function validateEvidence(evidence, pageCount, fail) {
  exact(evidence, EVIDENCE_KEYS, 'Accessibility review evidence', fail);
  for (const key of COUNT_EVIDENCE_KEYS) {
    const maximum = key === 'emptyExtractedTextPages' ? pageCount : 50_000;
    if (!boundedInteger(evidence[key], maximum)) fail('Accessibility review evidence counts are invalid.');
  }
  if (evidence.unicodeFonts + evidence.nonUnicodeFonts + evidence.unknownUnicodeFonts !== evidence.fonts
    || evidence.embeddedFonts + evidence.nonEmbeddedFonts + evidence.unknownEmbeddedFonts !== evidence.fonts) {
    fail('Accessibility font evidence counts are inconsistent.');
  }
  validateTagRoles(evidence.tagRoles, fail);
  validateOptionalPdfKit(evidence.optionalPdfKit, fail);
  validateSources(evidence.sources, evidence.optionalPdfKit.attempted, fail);
  if (!Array.isArray(evidence.imageTargets) || evidence.imageTargets.length !== Math.min(evidence.images, 128)) {
    fail('Accessibility image-target evidence is incomplete.');
  }
  for (const target of evidence.imageTargets) {
    exact(target, ['page', 'imageNumber', 'locator'], 'Accessibility image-target evidence', fail);
    if (target.page !== null && (!Number.isSafeInteger(target.page) || target.page < 1 || target.page > pageCount)
      || target.imageNumber !== null && !boundedInteger(target.imageNumber) || !SHA256.test(target.locator)) {
      fail('Accessibility image-target evidence is invalid.');
    }
  }
}

export function validateAccessibilityReviewChecksAndEvidence(report, fail) {
  validateChecks(report, fail);
  validateEvidence(report.evidence, report.pageCount, fail);
}
