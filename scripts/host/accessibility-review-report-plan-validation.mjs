import {
  ACCESSIBILITY_IMAGE_REMEDIATION,
  accessibilityRemediationCandidateTemplates,
} from './accessibility-review-remediation-plan.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;

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

function validatePlanMetadata(plan, report, fail) {
  exact(plan, ['kind', 'schemaVersion', 'profile', 'sourceSha256', 'status', 'candidateCount', 'truncated', 'candidates', 'tagRoleEvidenceDigest', 'reviewEvidenceSha256'], 'Accessibility remediation plan', fail);
  if (plan.kind !== 'accessibility-remediation-plan' || plan.schemaVersion !== 1
    || plan.profile !== 'source-bound-proposal-v1' || plan.sourceSha256 !== report.sourceDigest
    || plan.status !== 'proposal-only' || typeof plan.truncated !== 'boolean'
    || !Array.isArray(plan.candidates) || plan.candidates.length > 128
    || plan.candidateCount !== plan.candidates.length || !SHA256.test(plan.tagRoleEvidenceDigest)
    || plan.tagRoleEvidenceDigest !== report.sha256(report.evidence.tagRoles) || !SHA256.test(plan.reviewEvidenceSha256)) {
    fail('Accessibility remediation plan metadata is invalid.');
  }
}

function derivePlanTemplates(plan, report, fail) {
  const { attempted: _attempted, unavailableReason: _unavailableReason, ...pdfkit } = report.evidence.optionalPdfKit;
  const templates = accessibilityRemediationCandidateTemplates(report.checks, pdfkit);
  const total = templates.length + report.evidence.images;
  if (plan.candidateCount !== Math.min(128, total) || plan.truncated !== (total > 128)) {
    fail('Accessibility remediation candidates do not match the fixed derivation.');
  }
  return { pdfkit, templates };
}

function validateCandidateTarget(candidate, index, report, templates, fail) {
  if (index < templates.length && candidate.target !== undefined) {
    fail('Fixed metadata remediation candidates cannot contain an image target.');
  }
  if (index >= templates.length && candidate.target === undefined) {
    fail('Image remediation candidates require a fixed bounded target.');
  }
  if (candidate.target === undefined) return;
  const target = candidate.target;
  exact(target, ['page', 'imageNumber', 'locator'], 'Accessibility remediation target', fail);
  if (target.page !== null && (!Number.isSafeInteger(target.page) || target.page < 1 || target.page > report.pageCount)
    || target.imageNumber !== null && !boundedInteger(target.imageNumber) || !SHA256.test(target.locator)) {
    fail('Accessibility remediation target is invalid.');
  }
  const expectedTarget = report.evidence.imageTargets[index - templates.length];
  if (!expectedTarget || target.page !== expectedTarget.page || target.imageNumber !== expectedTarget.imageNumber
    || target.locator !== expectedTarget.locator) {
    fail('Accessibility remediation target does not match its source evidence.');
  }
}

function validatePlanCandidates(plan, report, templates, fail) {
  for (const [index, candidate] of plan.candidates.entries()) {
    const expected = index < templates.length ? templates[index] : ACCESSIBILITY_IMAGE_REMEDIATION;
    const keys = candidate.target === undefined
      ? ['id', 'action', 'reason', 'status', 'requires']
      : ['id', 'action', 'reason', 'status', 'requires', 'target'];
    exact(candidate, keys, 'Accessibility remediation candidate', fail);
    if (candidate.id !== `candidate-${index + 1}` || candidate.action !== expected.action
      || !ID.test(candidate.action) || candidate.reason !== expected.reason
      || candidate.status !== 'proposed-not-applied'
      || candidate.requires !== 'human-review-and-approved-tagged-pdf-writer') {
      fail('Accessibility remediation candidate is invalid.');
    }
    validateCandidateTarget(candidate, index, report, templates, fail);
  }
}

function validatePlanReviewEvidence(plan, report, pdfkit, fail) {
  const imageLocators = plan.candidates
    .filter(({ action, target }) => action === 'author-image-alt-text' && target?.locator)
    .map(({ target }) => target.locator);
  if (plan.reviewEvidenceSha256 !== report.sha256({
    sourceSha256: report.sourceDigest,
    checks: report.checks,
    tagRoles: report.evidence.tagRoles,
    optionalPdfKit: pdfkit,
    imageLocators,
  })) fail('Accessibility remediation plan evidence binding is invalid.');
}

export function validateAccessibilityReviewPlan(plan, report, fail, sha256) {
  const boundReport = { ...report, sha256 };
  validatePlanMetadata(plan, boundReport, fail);
  const { pdfkit, templates } = derivePlanTemplates(plan, boundReport, fail);
  validatePlanCandidates(plan, boundReport, templates, fail);
  validatePlanReviewEvidence(plan, boundReport, pdfkit, fail);
}
