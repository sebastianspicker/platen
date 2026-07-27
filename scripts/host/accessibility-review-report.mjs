import { deepFreeze, sha256 } from './accessibility-review-utils.mjs';

const STATUSES = Object.freeze(['pass', 'warning', 'fail', 'not-checked']);
const issuedReports = new WeakSet();
export const ACCESSIBILITY_REVIEW_LIMITATIONS = Object.freeze([
  'No PDF mutation was performed; every remediation candidate is proposed-not-applied.',
  'Tag-role shape checks are bounded heuristics and do not prove reading order or semantics.',
  'No page text, source path, image content, or PDF/UA conformance claim is returned.',
]);

function countChecks(checks) {
  return Object.freeze(Object.fromEntries(
    STATUSES.map((status) => [
      status,
      checks.filter((entry) => entry.status === status).length,
    ]),
  ));
}

function source(id, versionStatus, version = null) {
  return Object.freeze({ id, version, versionStatus });
}

function sources(version, pdfkitAttempted) {
  const popplerSources = [
    'poppler.pdfinfo',
    'poppler.pdfinfo-struct',
    'poppler.pdfinfo-meta',
    'poppler.pdfinfo-custom',
    'poppler.pdfinfo-url',
    'poppler.pdffonts',
    'poppler.pdfimages-list',
    'poppler.pdftotext-layout',
  ].map((id) => source(id, 'not-recorded-in-report'));
  const profileSource = source(
    'review-profile.capability-boundary',
    'recorded',
    String(version),
  );
  const pdfkitSources = pdfkitAttempted
    ? [
      source('apple-pdfkit.inventory', 'helper-version-not-recorded-in-report'),
      source('apple-pdfkit.outline-inventory', 'helper-version-not-recorded-in-report'),
      source('apple-pdfkit.document-permissions', 'helper-version-not-recorded-in-report'),
    ]
    : [];
  return Object.freeze([...popplerSources, profileSource, ...pdfkitSources]);
}

function reportEvidence({ evidence, roles, pdfkit, pdfkitAttempted, pdfkitUnavailableReason, sourceList }) {
  return Object.freeze({
    fonts: evidence.fonts,
    images: evidence.images,
    urls: evidence.urls,
    imageTargets: evidence.imageTargets,
    unicodeFonts: evidence.unicodeFonts,
    nonUnicodeFonts: evidence.nonUnicodeFonts,
    unknownUnicodeFonts: evidence.unknownUnicodeFonts,
    embeddedFonts: evidence.embeddedFonts,
    nonEmbeddedFonts: evidence.nonEmbeddedFonts,
    unknownEmbeddedFonts: evidence.unknownEmbeddedFonts,
    emptyExtractedTextPages: evidence.emptyTextPages,
    tagRoles: roles,
    optionalPdfKit: Object.freeze({
      attempted: pdfkitAttempted,
      ...(pdfkitUnavailableReason ? { unavailableReason: pdfkitUnavailableReason } : {}),
      ...pdfkit,
    }),
    sources: sourceList,
  });
}

export function serializeAccessibilityReview({
  version,
  document,
  pageCount,
  checks,
  evidence,
  roles,
  pdfkit,
  pdfkitAttempted,
  pdfkitUnavailableReason,
  plan,
}) {
  const counts = countChecks(checks);
  const reviewed = Object.freeze({
    kind: 'accessibility-review',
    profile: Object.freeze({
      id: 'basic-local-review',
      title: 'Basic local accessibility review',
      version,
    }),
    sourceDigest: document.sha256,
    pageCount,
    status: counts.fail ? 'fail' : 'review-required',
    counts,
    checks,
    evidence: reportEvidence({
      evidence,
      roles,
      pdfkit,
      pdfkitAttempted,
      pdfkitUnavailableReason,
      sourceList: sources(version, pdfkitAttempted),
    }),
    remediationPlan: plan,
    limitations: ACCESSIBILITY_REVIEW_LIMITATIONS,
  });
  const report = deepFreeze({ ...reviewed, reportSha256: sha256(reviewed) });
  issuedReports.add(report);
  return report;
}

export function isIssuedAccessibilityReviewReport(value) {
  return Boolean(value && typeof value === 'object' && issuedReports.has(value));
}
