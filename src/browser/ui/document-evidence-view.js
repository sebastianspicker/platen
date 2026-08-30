import { escapeHtml } from './shared.js';

const SIGNATURE_INTEGRITY = Object.freeze({
  unsigned: 'No embedded signatures',
  valid: 'Poppler reports valid integrity evidence',
  invalid: 'Poppler reports invalid integrity evidence',
  indeterminate: 'Poppler integrity evidence is indeterminate',
});

const SIGNATURE_CONCLUSION = Object.freeze({
  unsigned: 'Unsigned',
  valid: 'Integrity intact and current PDF fully covered',
  invalid: 'Embedded signature integrity failed',
  indeterminate: 'Current PDF signature state is indeterminate',
  'modified-after-signing': 'Covered revision intact; later PDF bytes are not covered',
});

const POPPLER_CONCLUSION = Object.freeze({
  unsigned: 'Poppler reports no embedded signatures',
  valid: 'Poppler reports valid integrity and full current-file coverage',
  invalid: 'Poppler reports an embedded integrity failure',
  indeterminate: 'Poppler could not determine the current-file signature state',
  'modified-after-signing': 'Poppler reports an intact covered revision with later uncovered PDF bytes',
});

const CMS_CROSS_CHECK = Object.freeze({
  verified: 'Every exact CMS verified against its declared signed byte ranges',
  indeterminate: 'One or more exact CMS checks are indeterminate or unsupported',
  unavailable: 'Exact CMS cross-check unavailable',
});

const CERTIFICATE_CHAIN_REASON = Object.freeze({
  none: 'No path error reported',
  expired: 'Certificate expired at evaluation time',
  'not-yet-valid': 'Certificate not yet valid at evaluation time',
  'not-trusted': 'Path did not reach the current macOS trust configuration',
  'explicitly-denied': 'Current macOS trust configuration explicitly denied the path',
  'policy-failure': 'macOS Basic X.509 policy failed',
  'malformed-cms': 'CMS container could not be evaluated',
  'missing-embedded-signer-certificate': 'Embedded signer certificate was unavailable',
  'multiple-cms-signers': 'Multiple CMS signers are outside this subset',
  'unsupported-subfilter': 'PDF signature subfilter is outside this subset',
  'cms-signature-mismatch': 'Exact CMS did not verify against the declared signed byte ranges',
  'resource-limit': 'Certificate-path resource limit reached',
  'evidence-mismatch': 'Poppler and native CMS/range evidence did not match',
  'platform-error': 'macOS path evaluation was unavailable',
});

function certificateChainLabel(chain) {
  if (!chain || !['passes', 'fails', 'indeterminate', 'unsupported'].includes(chain.status)) {
    return null;
  }
  const status = {
    passes: 'Passed macOS Basic X.509 path evaluation',
    fails: 'Failed macOS Basic X.509 path evaluation',
    indeterminate: 'Certificate path indeterminate',
    unsupported: 'Certificate path unsupported by this subset',
  }[chain.status];
  const reason = CERTIFICATE_CHAIN_REASON[chain.reason] ?? 'Bounded certificate evidence unavailable';
  const length = Number.isSafeInteger(chain.chainLength) && chain.chainLength >= 1 && chain.chainLength <= 16
    ? ` · ${chain.chainLength} certificate${chain.chainLength === 1 ? '' : 's'} in evaluated path`
    : '';
  return `${status} · ${reason}${length}`;
}

export function signatureAudit(signatures, property) {
  const popplerStatus = ['unsigned', 'valid', 'invalid', 'indeterminate'].includes(
    signatures?.popplerEvidence?.integrityStatus,
  )
    ? signatures.popplerEvidence.integrityStatus
    : ['unsigned', 'valid', 'invalid', 'indeterminate'].includes(signatures?.status)
      ? signatures.status
    : 'indeterminate';
  const count = Number.isSafeInteger(signatures?.signatureCount)
    && signatures.signatureCount >= 0
    ? signatures.signatureCount
    : null;
  const popplerCurrentDocumentStatus = signatures?.popplerEvidence?.currentDocumentStatus
    ?? signatures?.currentDocumentStatus
    ?? (popplerStatus === 'valid'
      && signatures?.signatures?.some?.(({ documentCoverage }) => (
        documentCoverage === 'prior-revision'
      ))
      ? 'modified-after-signing'
      : popplerStatus);
  const cmsCrossCheck = signatures?.cmsCrossCheck;
  const cmsCrossCheckStatus = ['verified', 'indeterminate'].includes(cmsCrossCheck?.status)
    ? cmsCrossCheck.status
    : popplerStatus === 'unsigned' ? 'verified' : 'unavailable';
  const overallCurrentDocumentStatus = popplerStatus === 'unsigned' ? 'unsigned'
    : popplerStatus === 'invalid' ? 'invalid'
      : popplerStatus === 'valid' && cmsCrossCheckStatus === 'verified'
        && ['valid', 'modified-after-signing'].includes(popplerCurrentDocumentStatus)
        ? popplerCurrentDocumentStatus
        : 'indeterminate';
  const allRecords = Array.isArray(signatures?.signatures) ? signatures.signatures : [];
  const records = allRecords.map((record, sourceOrder) => ({ record, sourceOrder }))
    .sort((left, right) => {
      const priority = ({ record }) => {
        if (['indeterminate', 'unsupported'].includes(record?.certificateChain?.status)) return 0;
        if (['invalid', 'indeterminate'].includes(record?.integrity)) return 1;
        if (record?.certificateChain?.status === 'fails') return 2;
        return 3;
      };
      return priority(left) - priority(right) || left.sourceOrder - right.sourceOrder;
    })
    .slice(0, 4)
    .map(({ record }) => record);
  const recordMarkup = records.map((signature, index) => {
    const number = Number.isSafeInteger(signature?.index) ? signature.index : index + 1;
    const coverage = signature?.documentCoverage === 'full'
      ? 'Full document'
      : signature?.documentCoverage === 'prior-revision'
        ? 'Prior revision only'
        : 'Not determined';
    const signer = signature?.claimedSigner?.commonName
      ?? signature?.claimedSigner?.distinguishedName
      ?? 'Not reported';
    const certificateChain = certificateChainLabel(signature?.certificateChain);
    return `${property(`Signature ${number} integrity`, signature?.integrity ?? 'Indeterminate')}${property(`Signature ${number} coverage`, coverage)}${certificateChain ? property(`Signature ${number} certificate path`, certificateChain) : ''}${property(`Claimed signer ${number} (unverified)`, signer)}${signature?.claimedSigningTime ? property(`Claimed signing time ${number} (unverified)`, signature.claimedSigningTime) : ''}`;
  }).join('');
  const omittedCount = Math.max(0, allRecords.length - records.length);
  const omittedMarkup = omittedCount > 0
    ? `<p class="field-help">Showing ${records.length} prioritized signature records; ${omittedCount} additional record${omittedCount === 1 ? ' is' : 's are'} omitted from this bounded view.</p>`
    : '';
  const evaluation = signatures?.certificateEvaluation;
  const chainEvaluated = evaluation?.profile === 'macos-basic-x509-current-trust-v2'
    && typeof evaluation.evaluatedAt === 'string' && !Number.isNaN(Date.parse(evaluation.evaluatedAt))
    && evaluation.verificationTimeBasis === 'host-current-time'
    && evaluation.anchorBasis === 'current-macos-trust-configuration'
    && evaluation.certificateNetworkFetchAllowed === false;
  const evaluationMarkup = chainEvaluated
    ? `${property('Certificate path policy', 'macOS Basic X.509')}${property('Certificate path evaluation time', evaluation.evaluatedAt)}${property('Certificate anchor basis', 'This Mac’s current trust configuration')}${property('Certificate fetching', 'Disabled')}`
    : '';
  const crossCheckCounts = cmsCrossCheckStatus === 'verified' || cmsCrossCheckStatus === 'indeterminate'
    ? ` · ${Number.isSafeInteger(cmsCrossCheck?.verifiedCount) ? cmsCrossCheck.verifiedCount : 0} verified · ${Number.isSafeInteger(cmsCrossCheck?.indeterminateCount) ? cmsCrossCheck.indeterminateCount : 0} indeterminate · ${Number.isSafeInteger(cmsCrossCheck?.unsupportedCount) ? cmsCrossCheck.unsupportedCount : 0} unsupported`
    : '';
  const crossCheckMarkup = popplerStatus === 'unsigned'
    ? ''
    : property('Exact CMS cross-check', `${CMS_CROSS_CHECK[cmsCrossCheckStatus]}${crossCheckCounts}`);
  const boundary = chainEvaluated
    ? 'Certificate path results use macOS Basic X.509 at the displayed host time with certificate fetching disabled. They do not establish signer identity, validity at signing time, revocation, timestamps, LTV, PDF-signing key usage, legal effect, or trust on another Mac. Claimed signer fields remain unverified.'
    : 'Offline inspection does not check certificate trust, signer identity, revocation, or timestamps. Claimed signer fields are unverified PDF claims.';
  return `${property('Overall signature conclusion', SIGNATURE_CONCLUSION[overallCurrentDocumentStatus] ?? SIGNATURE_CONCLUSION.indeterminate)}${property('Poppler pdfsig integrity', SIGNATURE_INTEGRITY[popplerStatus])}${property('Poppler coverage conclusion', POPPLER_CONCLUSION[popplerCurrentDocumentStatus] ?? POPPLER_CONCLUSION.indeterminate)}${crossCheckMarkup}${property('Embedded signatures', count)}${evaluationMarkup}${recordMarkup}${omittedMarkup}<p class="field-help">${boundary}</p>`;
}

export function namedDestinationInventory(structure) {
  const inventory = structure?.namedDestinations;
  if (!inventory || !Array.isArray(inventory.items)) {
    return '<div class="comparison-result" role="status"><strong>Named destinations</strong><span>Unavailable until local Poppler structure inspection completes.</span><span>Inventory limit: only validated local page destinations can be shown; this read-only inventory does not expose coordinates, zoom, actions, lookup, or authoring.</span></div>';
  }
  const pageCount = Number.isSafeInteger(structure?.pageCount) && structure.pageCount > 0
    ? structure.pageCount
    : null;
  const displayed = inventory.items.slice(0, 20);
  const displayTruncated = inventory.truncated === true || inventory.items.length > displayed.length;
  const itemMarkup = displayed.map((item) => {
    const page = item && typeof item === 'object' ? item.page : null;
    const name = item && typeof item === 'object' ? item.name : null;
    const navigable = Number.isSafeInteger(page) && page >= 1 && page <= pageCount
      && typeof name === 'string' && name.length > 0;
    if (navigable) {
      return `<li><button class="status-action" data-page-number="${page}">${escapeHtml(name)} · page ${page}</button></li>`;
    }
    const label = typeof name === 'string' && name ? name : 'Unnamed destination';
    return `<li><span>${escapeHtml(label)} · unresolved page</span></li>`;
  }).join('');
  const inventoryMarkup = displayed.length
    ? `<ul class="preflight-checks">${itemMarkup}</ul>`
    : '<span>No named destinations were reported.</span>';
  const truncationMarkup = displayTruncated
    ? '<span>Named destinations are retained at 200 records and only the first 20 are shown here.</span>'
    : '';
  return `<div class="comparison-result" role="status"><strong>Named destinations</strong>${inventoryMarkup}${truncationMarkup}<span>Inventory limit: page-level navigation only. This read-only inventory does not expose coordinates, zoom, actions, destination lookup, or authoring.</span></div>`;
}
