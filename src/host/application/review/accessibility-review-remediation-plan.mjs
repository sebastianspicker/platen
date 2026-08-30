import { sha256 } from './accessibility-review-utils.mjs';

const MAX_REMEDIATION_CANDIDATES = 128;

function template(action, reason) {
  return Object.freeze({ action, reason });
}

export const ACCESSIBILITY_IMAGE_REMEDIATION = template(
  'author-image-alt-text',
  'Alternative text requires human authorship and validation.',
);

export function accessibilityRemediationCandidateTemplates(checks, pdfkit) {
  const byId = new Map(checks.map((entry) => [entry.id, entry]));
  const candidates = [];
  const add = (action, reason) => candidates.push(template(action, reason));
  if (byId.get('tagged-indicator')?.status === 'fail'
    || byId.get('tag-structure-listing')?.status === 'fail') {
    add('author-tag-tree', 'No usable tag tree was reported.');
  }
  if (byId.get('document-title')?.status !== 'pass') {
    add('set-document-title', 'Document title metadata requires review.');
  }
  if (byId.get('document-language')?.status !== 'pass') {
    add('set-document-language', 'Document language metadata requires review.');
  }
  if (byId.get('font-tounicode')?.status === 'fail') {
    add('repair-font-unicode-mapping', 'One or more fonts lack Unicode mapping evidence.');
  }
  if (byId.get('font-embedding')?.status === 'fail') {
    add('embed-or-replace-fonts', 'One or more fonts are not reported as embedded.');
  }
  if (byId.get('empty-extracted-text-pages')?.status === 'warning') {
    add('review-empty-text-pages', 'One or more pages produced no extracted text.');
  }
  if (byId.get('reading-order')?.status !== 'pass') {
    add('author-reading-order', 'Logical reading order requires human review and authorship.');
  }
  if (byId.get('heading-role-sequence')?.status === 'warning') {
    add('repair-heading-hierarchy', 'The numbered heading-role sequence needs human review.');
  }
  if (byId.get('list-role-shape')?.status === 'warning') {
    add('repair-list-semantics', 'Reported list roles are structurally incomplete.');
  }
  if (byId.get('table-role-shape')?.status === 'warning') {
    add('repair-table-semantics', 'Reported table roles are structurally incomplete.');
  }
  if (byId.get('form-semantics')?.status !== 'pass') {
    add('review-form-semantics', 'Form labels, roles, and keyboard order require human review.');
  }
  if (byId.get('link-bookmark-semantics')?.status !== 'pass') {
    add('review-link-bookmark-semantics', 'Link purpose, destinations, and document navigation require human review.');
  }
  if (byId.get('artifact-classification')?.status !== 'pass') {
    add('review-artifact-classification', 'Decorative and repeated content requires human artifact classification.');
  }
  if (byId.get('contrast')?.status !== 'pass') {
    add('review-color-contrast', 'Color-only meaning and contrast require visual human review.');
  }
  if (pdfkit.contentAccessibility === false) {
    add('enable-assistive-access', 'PDF security does not permit content accessibility according to the local PDFKit evidence.');
  }
  return Object.freeze(candidates);
}

function imageTarget(document, image) {
  return Object.freeze({
    page: Number.isSafeInteger(image?.page) ? image.page : null,
    imageNumber: Number.isSafeInteger(image?.number) ? image.number : null,
    locator: sha256({
      sourceSha256: document.sha256,
      page: image?.page ?? null,
      number: image?.number ?? null,
      objectId: image?.objectId ?? null,
      generation: image?.generation ?? null,
      width: image?.width ?? null,
      height: image?.height ?? null,
    }),
  });
}

export function accessibilityImageTargets(document, images) {
  return Object.freeze(images.slice(0, MAX_REMEDIATION_CANDIDATES).map(
    (image) => imageTarget(document, image),
  ));
}

export function remediationPlan({ document, checks, imageTargets, imageCount, roles, pdfkit }) {
  const candidates = [];
  let truncated = false;
  const add = ({ action, reason }, target = null) => {
    if (candidates.length >= MAX_REMEDIATION_CANDIDATES) {
      truncated = true;
      return;
    }
    candidates.push(Object.freeze({
      id: `candidate-${candidates.length + 1}`,
      action,
      reason,
      status: 'proposed-not-applied',
      requires: 'human-review-and-approved-tagged-pdf-writer',
      ...(target ? { target } : {}),
    }));
  };
  for (const candidate of accessibilityRemediationCandidateTemplates(checks, pdfkit)) {
    add(candidate);
  }
  for (const target of imageTargets) add(ACCESSIBILITY_IMAGE_REMEDIATION, target);
  if (accessibilityRemediationCandidateTemplates(checks, pdfkit).length + imageCount
    > MAX_REMEDIATION_CANDIDATES) truncated = true;
  const imageLocators = candidates
    .filter(({ action, target }) => action === ACCESSIBILITY_IMAGE_REMEDIATION.action && target?.locator)
    .map(({ target }) => target.locator);
  return Object.freeze({
    kind: 'accessibility-remediation-plan',
    schemaVersion: 1,
    profile: 'source-bound-proposal-v1',
    sourceSha256: document.sha256,
    status: 'proposal-only',
    candidateCount: candidates.length,
    truncated,
    candidates: Object.freeze(candidates),
    tagRoleEvidenceDigest: sha256(roles),
    reviewEvidenceSha256: sha256({
      sourceSha256: document.sha256,
      checks,
      tagRoles: roles,
      optionalPdfKit: pdfkit,
      imageLocators,
    }),
  });
}
