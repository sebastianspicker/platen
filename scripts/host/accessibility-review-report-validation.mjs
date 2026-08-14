import { validateAccessibilityCheckSemantics } from './accessibility-review-check-validation.mjs';
import {
  validateAccessibilityReviewChecksAndEvidence,
} from './accessibility-review-report-evidence-validation.mjs';
import { validateAccessibilityReviewPlan } from './accessibility-review-report-plan-validation.mjs';
import { MAX_ACCESSIBILITY_REVIEW_BYTES, snapshotAccessibilityReview } from './accessibility-review-report-snapshot.mjs';
import {
  ACCESSIBILITY_REVIEW_LIMITATIONS,
  isIssuedAccessibilityReviewReport,
} from './accessibility-review-report.mjs';
import { deepFreeze, reportSize, sha256 } from './accessibility-review-utils.mjs';
import { HostError } from './host-error.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const ROOT_KEYS = Object.freeze([
  'kind', 'profile', 'sourceDigest', 'pageCount', 'status', 'counts', 'checks',
  'evidence', 'remediationPlan', 'limitations', 'reportSha256',
]);

function fail(message, code = 'ACCESSIBILITY_REVIEW_INVALID') {
  throw new HostError(code, message, 502);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} must contain the exact required fields.`);
  }
}

function validateInheritedJsonHooks() {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) {
    fail('Accessibility review validation rejects inherited JSON hooks.');
  }
}

function validateReviewIdentity(value, expectedSourceDigest) {
  exact(value, ROOT_KEYS, 'Accessibility review');
  exact(value.profile, ['id', 'title', 'version'], 'Accessibility review profile');
  if (value.kind !== 'accessibility-review' || value.profile.id !== 'basic-local-review'
    || value.profile.title !== 'Basic local accessibility review' || value.profile.version !== 3
    || !SHA256.test(value.sourceDigest) || value.sourceDigest !== expectedSourceDigest
    || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 200
    || !SHA256.test(value.reportSha256)) {
    fail('Accessibility review identity or source binding is invalid.');
  }
}

function validateReviewLimitations(value) {
  if (!Array.isArray(value.limitations) || value.limitations.length !== ACCESSIBILITY_REVIEW_LIMITATIONS.length
    || value.limitations.some((limitation, index) => limitation !== ACCESSIBILITY_REVIEW_LIMITATIONS[index])) {
    fail('Accessibility review limitations do not match the fixed non-conformance boundary.');
  }
}

function validateReviewIntegrityAndSize(value) {
  const { reportSha256, ...unsigned } = value;
  if (sha256(unsigned) !== reportSha256) {
    fail('Accessibility review digest verification failed.', 'ACCESSIBILITY_REVIEW_INTEGRITY_FAILED');
  }
  if (reportSize(value) > MAX_ACCESSIBILITY_REVIEW_BYTES) fail('Accessibility review exceeds its report-size limit.');
}

function validateTrustedReviewPublication(report, requireTrustedIssue) {
  if (typeof requireTrustedIssue !== 'boolean' || requireTrustedIssue && !isIssuedAccessibilityReviewReport(report)) {
    fail('Accessibility review publication requires an exact host-issued report.');
  }
}

/** Validates and snapshots one source-bound, non-conforming accessibility review. */
export function validateAccessibilityReviewReport(
  report,
  { expectedSourceDigest, requireTrustedIssue = true } = {},
) {
  validateInheritedJsonHooks();
  const value = snapshotAccessibilityReview(report, fail);
  validateReviewIdentity(value, expectedSourceDigest);
  validateAccessibilityReviewChecksAndEvidence(value, fail);
  validateAccessibilityCheckSemantics(value, fail);
  validateAccessibilityReviewPlan(value.remediationPlan, value, fail, sha256);
  validateReviewLimitations(value);
  validateReviewIntegrityAndSize(value);
  validateTrustedReviewPublication(report, requireTrustedIssue);
  return requireTrustedIssue ? report : deepFreeze(value);
}
