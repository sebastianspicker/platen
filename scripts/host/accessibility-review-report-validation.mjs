import { isProxy } from 'node:util/types';
import { ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS } from './accessibility-review-check-contract.mjs';
import { validateAccessibilityCheckSemantics } from './accessibility-review-check-validation.mjs';
import {
  ACCESSIBILITY_REVIEW_LIMITATIONS,
  isIssuedAccessibilityReviewReport,
} from './accessibility-review-report.mjs';
import {
  ACCESSIBILITY_IMAGE_REMEDIATION,
  accessibilityRemediationCandidateTemplates,
} from './accessibility-review-remediation-plan.mjs';
import { deepFreeze, reportSize, sha256 } from './accessibility-review-utils.mjs';
import { HostError } from './host-error.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const EVIDENCE_ID = /^[a-z][a-z0-9.-]{0,79}$/u;
const ROLE = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;
const STATUSES = Object.freeze(['pass', 'warning', 'fail', 'not-checked']);
const CHECK_IDS = Object.freeze(Object.keys(ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS));
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_SNAPSHOT_ITEMS = 20_000;
const MAX_SNAPSHOT_DEPTH = 16;
const ROOT_KEYS = Object.freeze([
  'kind', 'profile', 'sourceDigest', 'pageCount', 'status', 'counts', 'checks',
  'evidence', 'remediationPlan', 'limitations', 'reportSha256',
]);
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

function fail(message, code = 'ACCESSIBILITY_REVIEW_INVALID') {
  throw new HostError(code, message, 502);
}

function snapshotJson(value, state = { active: new Set(), items: 0 }, depth = 0) {
  state.items += 1;
  if (state.items > MAX_SNAPSHOT_ITEMS || depth > MAX_SNAPSHOT_DEPTH) {
    fail('The accessibility review exceeds its structural limits.');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_REPORT_BYTES) fail('The accessibility review contains oversized text.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('The accessibility review contains a non-finite number.');
    return value;
  }
  if (!value || typeof value !== 'object' || isProxy(value) || state.active.has(value)) {
    fail('The accessibility review must be acyclic plain JSON data.');
  }
  state.active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  let result;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_SNAPSHOT_ITEMS) {
      fail('The accessibility review contains an invalid array.');
    }
    const expected = Array.from({ length: value.length }, (_, index) => String(index));
    const actual = keys.filter((key) => key !== 'length');
    if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string')
      || expected.some((key) => !Object.hasOwn(descriptors, key)
        || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) {
      fail('The accessibility review requires dense data-only arrays.');
    }
    result = expected.map((key) => snapshotJson(descriptors[key].value, state, depth + 1));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('The accessibility review contains a non-plain object.');
    }
    if (keys.some((key) => typeof key !== 'string'
      || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) {
      fail('The accessibility review requires data properties only.');
    }
    result = Object.create(null);
    for (const key of keys) result[key] = snapshotJson(descriptors[key].value, state, depth + 1);
  }
  state.active.delete(value);
  return result;
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} must contain the exact required fields.`);
  }
}

function boundedInteger(value, maximum = 50_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateChecks(report) {
  exact(report.counts, STATUSES, 'Accessibility review counts');
  if (!Array.isArray(report.checks) || report.checks.length !== CHECK_IDS.length) {
    fail('The accessibility review must contain the fixed check set.');
  }
  for (const [index, check] of report.checks.entries()) {
    exact(check, ['id', 'status', 'summary', 'evidenceRefs'], 'Accessibility review check');
    const expectedId = CHECK_IDS[index];
    const expectedRefs = ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS[expectedId];
    if (check.id !== expectedId || !STATUSES.includes(check.status)
      || typeof check.summary !== 'string' || check.summary.length < 1 || check.summary.length > 240
      || Buffer.byteLength(check.summary) > 960
      || !Array.isArray(check.evidenceRefs)
      || check.evidenceRefs.length !== expectedRefs.length
      || check.evidenceRefs.some((reference, refIndex) => reference !== expectedRefs[refIndex])) {
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

function validateTagRoles(tagRoles) {
  exact(tagRoles, ROLE_KEYS, 'Accessibility tag-role evidence');
  if (!tagRoles.roleCounts || typeof tagRoles.roleCounts !== 'object'
    || Array.isArray(tagRoles.roleCounts)) {
    fail('Accessibility tag-role counts must be an object.');
  }
  exact(tagRoles.roleCounts, Object.keys(tagRoles.roleCounts), 'Accessibility tag-role counts');
  const countKeys = Object.keys(tagRoles.roleCounts);
  if (countKeys.length > 64 || countKeys.some((key) => !ROLE.test(key)
    || !boundedInteger(tagRoles.roleCounts[key]))) fail('Accessibility tag-role counts are invalid.');
  for (const key of ROLE_KEYS.filter((key) => key.endsWith('Count'))) {
    if (!boundedInteger(tagRoles[key])) fail('Accessibility tag-role evidence counts are invalid.');
  }
  if (!['complete', 'unknown'].includes(tagRoles.hierarchyCoverage)
    || typeof tagRoles.headingSequenceViolation !== 'boolean') {
    fail('Accessibility tag-role evidence is invalid.');
  }
}

function validateOptionalPdfKit(value) {
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
  if (value.available) {
    if (!value.attempted || Object.hasOwn(value, 'unavailableReason')) fail('Available PDFKit evidence has an invalid state.');
    for (const key of ['contentAccessibility', 'permissionStatus', 'widgetCount', 'unnamedWidgetCount', 'widgetsTruncated', 'outlineItemCount', 'outlineTruncated']) {
      if (!Object.hasOwn(value, key)) fail('Available PDFKit evidence is incomplete.');
    }
    if (!(value.contentAccessibility === null || typeof value.contentAccessibility === 'boolean')
      || !['none', 'user', 'owner', 'unknown'].includes(value.permissionStatus)
      || !boundedInteger(value.widgetCount, 5_000)
      || !boundedInteger(value.unnamedWidgetCount, 5_000)
      || !boundedInteger(value.outlineItemCount, 200)
      || typeof value.widgetsTruncated !== 'boolean'
      || typeof value.outlineTruncated !== 'boolean') fail('Available PDFKit evidence is invalid.');
  } else if (keys.some((key) => !['attempted', 'available', 'unavailableReason'].includes(key))
    || (value.unavailableReason === 'document-unsupported') !== value.attempted) {
    fail('Unavailable PDFKit evidence has an invalid state.');
  }
}

function validateSources(sources, attempted) {
  const expectedIds = attempted ? [...BASE_SOURCE_IDS, ...PDFKIT_SOURCE_IDS] : BASE_SOURCE_IDS;
  if (!Array.isArray(sources) || sources.length !== expectedIds.length) fail('Accessibility evidence sources are incomplete.');
  for (const [index, source] of sources.entries()) {
    exact(source, ['id', 'version', 'versionStatus'], 'Accessibility evidence source');
    if (typeof source.id !== 'string' || !EVIDENCE_ID.test(source.id)
      || !(source.version === null || (typeof source.version === 'string' && source.version.length <= 32))
      || !['recorded', 'not-recorded-in-report', 'helper-version-not-recorded-in-report'].includes(source.versionStatus)) {
      fail('Accessibility evidence source metadata is invalid.');
    }
    if (source.id !== expectedIds[index]) fail('Accessibility evidence sources are not in the fixed profile order.');
    const isProfile = source.id === 'review-profile.capability-boundary';
    const isPdfKit = source.id.startsWith('apple-pdfkit.');
    if (source.version !== (isProfile ? '3' : null)
      || source.versionStatus !== (isProfile ? 'recorded' : isPdfKit ? 'helper-version-not-recorded-in-report' : 'not-recorded-in-report')) {
      fail('Accessibility evidence source version metadata is invalid.');
    }
  }
}

function validateEvidence(evidence, pageCount) {
  exact(evidence, EVIDENCE_KEYS, 'Accessibility review evidence');
  for (const key of COUNT_EVIDENCE_KEYS) {
    const maximum = key === 'emptyExtractedTextPages' ? pageCount : 50_000;
    if (!boundedInteger(evidence[key], maximum)) fail('Accessibility review evidence counts are invalid.');
  }
  if (evidence.unicodeFonts + evidence.nonUnicodeFonts + evidence.unknownUnicodeFonts !== evidence.fonts
    || evidence.embeddedFonts + evidence.nonEmbeddedFonts + evidence.unknownEmbeddedFonts !== evidence.fonts) {
    fail('Accessibility font evidence counts are inconsistent.');
  }
  validateTagRoles(evidence.tagRoles);
  validateOptionalPdfKit(evidence.optionalPdfKit);
  validateSources(evidence.sources, evidence.optionalPdfKit.attempted);
  if (!Array.isArray(evidence.imageTargets)
    || evidence.imageTargets.length !== Math.min(evidence.images, 128)) {
    fail('Accessibility image-target evidence is incomplete.');
  }
  for (const target of evidence.imageTargets) {
    exact(target, ['page', 'imageNumber', 'locator'], 'Accessibility image-target evidence');
    const validPage = target.page === null
      || (Number.isSafeInteger(target.page) && target.page >= 1 && target.page <= pageCount);
    const validImage = target.imageNumber === null || boundedInteger(target.imageNumber);
    if (!validPage || !validImage || !SHA256.test(target.locator)) {
      fail('Accessibility image-target evidence is invalid.');
    }
  }
}

function validatePlan(plan, report) {
  exact(plan, ['kind', 'schemaVersion', 'profile', 'sourceSha256', 'status', 'candidateCount', 'truncated', 'candidates', 'tagRoleEvidenceDigest', 'reviewEvidenceSha256'], 'Accessibility remediation plan');
  if (plan.kind !== 'accessibility-remediation-plan' || plan.schemaVersion !== 1
    || plan.profile !== 'source-bound-proposal-v1' || plan.sourceSha256 !== report.sourceDigest
    || plan.status !== 'proposal-only' || typeof plan.truncated !== 'boolean'
    || !Array.isArray(plan.candidates) || plan.candidates.length > 128
    || plan.candidateCount !== plan.candidates.length || !SHA256.test(plan.tagRoleEvidenceDigest)
    || plan.tagRoleEvidenceDigest !== sha256(report.evidence.tagRoles)
    || !SHA256.test(plan.reviewEvidenceSha256)) fail('Accessibility remediation plan metadata is invalid.');
  const { attempted: _attempted, unavailableReason: _unavailableReason, ...pdfkit } = report.evidence.optionalPdfKit;
  const templates = accessibilityRemediationCandidateTemplates(report.checks, pdfkit);
  const expectedCandidateCount = Math.min(128, templates.length + report.evidence.images);
  if (plan.candidateCount !== expectedCandidateCount
    || plan.truncated !== (templates.length + report.evidence.images > 128)) {
    fail('Accessibility remediation candidates do not match the fixed derivation.');
  }
  for (const [index, candidate] of plan.candidates.entries()) {
    const expected = index < templates.length
      ? templates[index]
      : ACCESSIBILITY_IMAGE_REMEDIATION;
    const keys = candidate.target === undefined
      ? ['id', 'action', 'reason', 'status', 'requires']
      : ['id', 'action', 'reason', 'status', 'requires', 'target'];
    exact(candidate, keys, 'Accessibility remediation candidate');
    if (candidate.id !== `candidate-${index + 1}` || candidate.action !== expected.action
      || !ID.test(candidate.action) || candidate.reason !== expected.reason
      || candidate.status !== 'proposed-not-applied'
      || candidate.requires !== 'human-review-and-approved-tagged-pdf-writer') {
      fail('Accessibility remediation candidate is invalid.');
    }
    if (index < templates.length && candidate.target !== undefined) {
      fail('Fixed metadata remediation candidates cannot contain an image target.');
    }
    if (index >= templates.length && candidate.target === undefined) {
      fail('Image remediation candidates require a fixed bounded target.');
    }
    if (candidate.target !== undefined) {
      exact(candidate.target, ['page', 'imageNumber', 'locator'], 'Accessibility remediation target');
      const validPage = candidate.target.page === null
        || (Number.isSafeInteger(candidate.target.page) && candidate.target.page >= 1 && candidate.target.page <= report.pageCount);
      const validImage = candidate.target.imageNumber === null
        || boundedInteger(candidate.target.imageNumber);
      if (!validPage || !validImage || !SHA256.test(candidate.target.locator)) fail('Accessibility remediation target is invalid.');
      const expectedTarget = report.evidence.imageTargets[index - templates.length];
      if (!expectedTarget || candidate.target.page !== expectedTarget.page
        || candidate.target.imageNumber !== expectedTarget.imageNumber
        || candidate.target.locator !== expectedTarget.locator) {
        fail('Accessibility remediation target does not match its source evidence.');
      }
    }
  }
  const imageLocators = plan.candidates
    .filter(({ action, target }) => action === 'author-image-alt-text' && target?.locator)
    .map(({ target }) => target.locator);
  const expectedReviewEvidenceSha256 = sha256({
    sourceSha256: report.sourceDigest,
    checks: report.checks,
    tagRoles: report.evidence.tagRoles,
    optionalPdfKit: pdfkit,
    imageLocators,
  });
  if (plan.reviewEvidenceSha256 !== expectedReviewEvidenceSha256) {
    fail('Accessibility remediation plan evidence binding is invalid.');
  }
}

/** Validates and snapshots one source-bound, non-conforming accessibility review. */
export function validateAccessibilityReviewReport(
  report,
  { expectedSourceDigest, requireTrustedIssue = true } = {},
) {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) {
    fail('Accessibility review validation rejects inherited JSON hooks.');
  }
  const value = snapshotJson(report);
  exact(value, ROOT_KEYS, 'Accessibility review');
  exact(value.profile, ['id', 'title', 'version'], 'Accessibility review profile');
  if (value.kind !== 'accessibility-review'
    || value.profile.id !== 'basic-local-review'
    || value.profile.title !== 'Basic local accessibility review'
    || value.profile.version !== 3 || !SHA256.test(value.sourceDigest)
    || value.sourceDigest !== expectedSourceDigest
    || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 200
    || !SHA256.test(value.reportSha256)) fail('Accessibility review identity or source binding is invalid.');
  validateChecks(value);
  validateEvidence(value.evidence, value.pageCount);
  validateAccessibilityCheckSemantics(value, fail);
  validatePlan(value.remediationPlan, value);
  if (!Array.isArray(value.limitations)
    || value.limitations.length !== ACCESSIBILITY_REVIEW_LIMITATIONS.length
    || value.limitations.some((limitation, index) => limitation !== ACCESSIBILITY_REVIEW_LIMITATIONS[index])) {
    fail('Accessibility review limitations do not match the fixed non-conformance boundary.');
  }
  const { reportSha256, ...unsigned } = value;
  if (sha256(unsigned) !== reportSha256) fail('Accessibility review digest verification failed.', 'ACCESSIBILITY_REVIEW_INTEGRITY_FAILED');
  if (reportSize(value) > MAX_REPORT_BYTES) fail('Accessibility review exceeds its report-size limit.');
  if (typeof requireTrustedIssue !== 'boolean'
    || (requireTrustedIssue && !isIssuedAccessibilityReviewReport(report))) {
    fail('Accessibility review publication requires an exact host-issued report.');
  }
  return requireTrustedIssue ? report : deepFreeze(value);
}
