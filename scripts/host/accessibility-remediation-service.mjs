import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';

export const ACCESSIBILITY_REMEDIATION_PROPOSAL_SCHEMA_VERSION = 1;
export const ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS = 128;
export const ACCESSIBILITY_REMEDIATION_MAX_EXPORT_BYTES = 128 * 1024;
export const ACCESSIBILITY_REMEDIATION_MEDIA_TYPE = 'application/vnd.platen.accessibility-proposal+json';

const SHA256 = /^[a-f0-9]{64}$/;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9-]{0,63}$/;
const PATH_LIKE = /^(?:\/|~\/|\.\.?[\\/]|[A-Za-z]:[\\/]|\\\\)/;
const AUTHOR_IMAGE_ALT_TEXT_ACTION = 'author-image-alt-text';
const REQUEST_KEYS = new Set(['sourceSha256', 'reviewSha256', 'expectedWorkspaceRevision', 'operations']);
const OPERATION_KEYS = new Set(['action', 'target']);
const AUTHORED_TEXT_OPERATION_KEYS = new Set(['action', 'target', 'authoredText']);
const TARGET_KEYS = new Set(['locator']);
const PROPOSAL_KEYS = new Set(['schemaVersion', 'id', 'type', 'status', 'sourceSha256', 'reviewSha256', 'expectedWorkspaceRevision', 'pdfWriterRequired', 'conformanceClaim', 'operations']);
const EXPORTED_OPERATION_KEYS = new Set(['id', 'action', 'target', 'status', 'pdfWriterRequired', 'conformanceClaim']);
const EXPORTED_AUTHORED_TEXT_OPERATION_KEYS = new Set([...EXPORTED_OPERATION_KEYS, 'authoredText']);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, expected, label) {
  if (!plain(value) || Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    fail('ACCESSIBILITY_PROPOSAL_INVALID', `${label} must contain the required fields only.`);
  }
  for (const key of expected) if (!Object.hasOwn(value, key)) fail('ACCESSIBILITY_PROPOSAL_INVALID', `${label} is missing ${key}.`);
}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Proposal JSON must contain finite numbers only.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!plain(value)) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Proposal JSON must be plain JSON data.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function issuanceKey(documentId, proposalId) { return `${documentId}\u0000${proposalId}`; }
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('ACCESSIBILITY_PROPOSAL_INVALID', `${label} must be a lowercase SHA-256 digest.`);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ACCESSIBILITY_PROPOSAL_REVISION_REQUIRED', 'A current non-negative workspace revision is required.');
  return value;
}
function validateTarget(value) {
  if (value === null) return null;
  exact(value, TARGET_KEYS, 'Operation target');
  return frozen({ locator: digest(value.locator, 'Operation target locator') });
}
function normalizeAuthoredText(value) {
  if (typeof value !== 'string') fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text must be a string.');
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 1 || normalized.length > 1000) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text must contain 1 to 1000 UTF-16 code units.');
  if (PATH_LIKE.test(normalized)) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text must not begin with a path-like value.');
  if (/[\u0000-\u001F\u007F-\u009F]|\p{Cf}/u.test(normalized)) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text must not contain control or format characters.');
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      if (index + 1 >= normalized.length || normalized.charCodeAt(index + 1) < 0xDC00 || normalized.charCodeAt(index + 1) > 0xDFFF) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text must not contain unpaired surrogates.');
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text must not contain unpaired surrogates.');
  }
  return normalized;
}
function validateOperations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS) {
    fail('ACCESSIBILITY_PROPOSAL_OPERATION_LIMIT', `Accessibility remediation proposals support at most ${ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS} operations.`, 413);
  }
  return frozen(value.map((operation, index) => {
    const includesAuthoredText = plain(operation) && Object.hasOwn(operation, 'authoredText');
    exact(operation, includesAuthoredText ? AUTHORED_TEXT_OPERATION_KEYS : OPERATION_KEYS, 'Operation');
    if (typeof operation.action !== 'string' || !ACTION.test(operation.action)) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Operation action must be a bounded machine-readable identifier.');
    const target = validateTarget(operation.target);
    if (!includesAuthoredText && operation.action === AUTHOR_IMAGE_ALT_TEXT_ACTION) {
      fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Author-image-alt-text operations require explicit authored image alt text.');
    }
    if (includesAuthoredText && (operation.action !== AUTHOR_IMAGE_ALT_TEXT_ACTION || target === null)) {
      fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Authored image alt text requires an author-image-alt-text operation with a locator.');
    }
    const normalized = includesAuthoredText ? normalizeAuthoredText(operation.authoredText) : undefined;
    return frozen({
      id: `operation-${index + 1}`,
      action: operation.action,
      target,
      ...(includesAuthoredText ? { authoredText: normalized } : {}),
      status: 'proposed-not-applied',
      pdfWriterRequired: true,
      conformanceClaim: false,
    });
  }));
}
function assertTrustedCandidates(operations, review) {
  const candidates = review?.remediationPlan?.candidates;
  if (!Array.isArray(candidates) || candidates.length > ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS) {
    fail('ACCESSIBILITY_REVIEW_INVALID', 'The trusted review does not contain a bounded remediation candidate set.', 502);
  }
  const used = new Set();
  const targets = new Set();
  for (const operation of operations) {
    const targetKey = `${operation.action}\u0000${operation.target?.locator ?? ''}`;
    if (targets.has(targetKey)) fail('ACCESSIBILITY_PROPOSAL_DUPLICATE_TARGET', 'Proposal operations must not target the same trusted candidate twice.', 409);
    targets.add(targetKey);
    const index = candidates.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex) || candidate?.status !== 'proposed-not-applied'
        || candidate?.action !== operation.action) return false;
      const candidateLocator = candidate?.target?.locator ?? null;
      const operationLocator = operation.target?.locator ?? null;
      return candidateLocator === operationLocator;
    });
    if (index === -1) {
      fail('ACCESSIBILITY_PROPOSAL_NOT_IN_REVIEW', 'Every proposal operation must match one current trusted review candidate.', 409);
    }
    used.add(index);
  }
}
function reviewPayload(review) {
  if (!plain(review) || review.kind !== 'accessibility-review' || typeof review.sourceDigest !== 'string' || typeof review.reportSha256 !== 'string') {
    fail('ACCESSIBILITY_REVIEW_INVALID', 'The trusted review provider did not return a valid accessibility review.', 502);
  }
  const { reportSha256, ...unsigned } = review;
  if (!SHA256.test(review.sourceDigest) || !SHA256.test(reportSha256) || hash(unsigned) !== reportSha256) {
    fail('ACCESSIBILITY_REVIEW_INTEGRITY_FAILED', 'The trusted accessibility review digest does not match its content.', 502);
  }
  return review;
}

/** Stores a single source- and review-bound proposal; this service never writes PDF bytes. */
export class AccessibilityRemediationService {
  #documents; #workspace; #reviews; #idFactory; #issued = new Map();

  constructor({ documentStore, workspaceStateStore, reviewProvider, idFactory } = {}) {
    if (!documentStore || typeof documentStore.getDocument !== 'function' || typeof documentStore.verifySource !== 'function') throw new TypeError('AccessibilityRemediationService requires a DocumentStore-compatible store.');
    if (!workspaceStateStore || typeof workspaceStateStore.createEntity !== 'function' || typeof workspaceStateStore.snapshot !== 'function') throw new TypeError('AccessibilityRemediationService requires WorkspaceStateStore.');
    if (!reviewProvider || typeof reviewProvider.review !== 'function') throw new TypeError('AccessibilityRemediationService requires a trusted reviewProvider.review(documentId).');
    this.#documents = documentStore; this.#workspace = workspaceStateStore; this.#reviews = reviewProvider;
    let serial = 0;
    this.#idFactory = idFactory ?? (() => `accessibility-proposal-${++serial}`);
    if (typeof this.#idFactory !== 'function') throw new TypeError('idFactory must be a function.');
  }

  async createProposal(documentId, request) {
    exact(request, REQUEST_KEYS, 'Accessibility remediation proposal request');
    const expectedSource = digest(request.sourceSha256, 'sourceSha256');
    const expectedReview = digest(request.reviewSha256, 'reviewSha256');
    const expectedWorkspaceRevision = revision(request.expectedWorkspaceRevision);
    const operations = validateOperations(request.operations);
    const document = this.#documents.getDocument(documentId);
    if (!document || digest(document.sha256, 'document source digest') !== expectedSource) fail('ACCESSIBILITY_PROPOSAL_SOURCE_MISMATCH', 'The proposal belongs to a different immutable source PDF.', 409);
    await this.#documents.verifySource(documentId);
    const review = reviewPayload(await this.#reviews.review(documentId));
    if (review.sourceDigest !== expectedSource || review.reportSha256 !== expectedReview) fail('ACCESSIBILITY_PROPOSAL_REVIEW_STALE', 'The supplied review digest is not the current trusted review for this source PDF.', 409);
    assertTrustedCandidates(operations, review);
    await this.#documents.verifySource(documentId);
    const id = this.#idFactory();
    if (typeof id !== 'string' || !ENTITY_ID.test(id)) fail('ACCESSIBILITY_PROPOSAL_ID_INVALID', 'The local proposal identifier is invalid.', 500);
    const key = issuanceKey(documentId, id);
    if (this.#issued.has(key)) fail('ACCESSIBILITY_PROPOSAL_ID_COLLISION', 'The local proposal identifier was already issued.', 409);
    const proposal = frozen({
      schemaVersion: ACCESSIBILITY_REMEDIATION_PROPOSAL_SCHEMA_VERSION,
      id,
      type: 'accessibility-remediation-proposal',
      status: 'proposed-not-applied',
      sourceSha256: expectedSource,
      reviewSha256: expectedReview,
      expectedWorkspaceRevision,
      pdfWriterRequired: true,
      conformanceClaim: false,
      operations,
    });
    exact(proposal, PROPOSAL_KEYS, 'Accessibility remediation proposal');
    const snapshot = this.#workspace.createEntity(documentId, 'accessibilityTags', proposal, { expectedRevision: expectedWorkspaceRevision });
    this.#issued.set(key, hash(proposal));
    return frozen({ proposalId: id, revision: snapshot.revision, status: proposal.status, pdfWriterRequired: true, conformanceClaim: false });
  }

  exportProposal(documentId, proposalId) {
    if (typeof proposalId !== 'string' || !ENTITY_ID.test(proposalId)) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Proposal export requires a valid server-side proposal identifier.');
    const issuedDigest = this.#issued.get(issuanceKey(documentId, proposalId));
    if (!issuedDigest) fail('ACCESSIBILITY_PROPOSAL_NOT_ISSUED', 'The accessibility remediation proposal was not issued by this local service.', 404);
    const record = this.#workspace.snapshot(documentId).namespaces.accessibilityTags.find((item) => item.id === proposalId && item.type === 'accessibility-remediation-proposal');
    if (!record) fail('ACCESSIBILITY_PROPOSAL_NOT_FOUND', 'The accessibility remediation proposal was not found.', 404);
    exact(record, PROPOSAL_KEYS, 'Stored accessibility remediation proposal');
    if (record.schemaVersion !== 1 || record.status !== 'proposed-not-applied' || record.pdfWriterRequired !== true || record.conformanceClaim !== false) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Stored accessibility remediation proposal is invalid.');
    digest(record.sourceSha256, 'Stored sourceSha256'); digest(record.reviewSha256, 'Stored reviewSha256'); revision(record.expectedWorkspaceRevision);
    if (!Array.isArray(record.operations) || record.operations.length > ACCESSIBILITY_REMEDIATION_MAX_OPERATIONS) fail('ACCESSIBILITY_PROPOSAL_OPERATION_LIMIT', 'Stored proposal has too many operations.', 413);
    for (const [index, operation] of record.operations.entries()) {
      const includesAuthoredText = plain(operation) && Object.hasOwn(operation, 'authoredText');
      exact(operation, includesAuthoredText ? EXPORTED_AUTHORED_TEXT_OPERATION_KEYS : EXPORTED_OPERATION_KEYS, 'Stored proposal operation');
      if (operation.id !== `operation-${index + 1}` || typeof operation.action !== 'string' || !ACTION.test(operation.action) || operation.status !== 'proposed-not-applied' || operation.pdfWriterRequired !== true || operation.conformanceClaim !== false) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Stored proposal operation is invalid.');
      const target = validateTarget(operation.target);
      if (!includesAuthoredText && operation.action === AUTHOR_IMAGE_ALT_TEXT_ACTION) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Stored author-image-alt-text operation is missing authored image alt text.');
      if (includesAuthoredText) {
        if (operation.action !== AUTHOR_IMAGE_ALT_TEXT_ACTION || target === null || normalizeAuthoredText(operation.authoredText) !== operation.authoredText) fail('ACCESSIBILITY_PROPOSAL_INVALID', 'Stored authored image alt text operation is invalid.');
      }
    }
    const exported = canonical(record);
    if (hash(record) !== issuedDigest) fail('ACCESSIBILITY_PROPOSAL_ISSUANCE_MISMATCH', 'The stored accessibility remediation proposal no longer matches its issued record.', 409);
    if (Buffer.byteLength(exported, 'utf8') > ACCESSIBILITY_REMEDIATION_MAX_EXPORT_BYTES) fail('ACCESSIBILITY_PROPOSAL_EXPORT_LIMIT', 'Accessibility remediation proposal export exceeds its local size limit.', 413);
    return exported;
  }
}

export function canonicalizeAccessibilityRemediationProposal(value) { return canonical(value); }
