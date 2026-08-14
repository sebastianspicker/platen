import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { normalizeAccessibilityAltText } from './accessibility-alt-text-contract.js';
import { exactObject } from './pdfkit-client-contract.js';

const ACCESSIBILITY_PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACCESSIBILITY_ACTION = /^[a-z][a-z0-9-]{0,63}$/;
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/;
const STANDARDS_PROFILES = Object.freeze([
  'pdfa-1a', 'pdfa-1b', 'pdfa-2a', 'pdfa-2b', 'pdfa-2u',
  'pdfa-3a', 'pdfa-3b', 'pdfa-3u', 'pdfa-4', 'pdfa-4e', 'pdfa-4f',
  'pdfua-1', 'pdfua-2', 'pdfx',
]);

function validSignal(signal) {
  return signal === undefined || signal instanceof AbortSignal;
}

function validSignalOptions(options) {
  return exactObject(options, options?.signal === undefined ? [] : ['signal'])
    && validSignal(options?.signal);
}

function validAllowedOptions(options, allowedKeys) {
  return Boolean(options && typeof options === 'object' && !Array.isArray(options)
    && Object.keys(options).every((key) => allowedKeys.includes(key)));
}

function normalizedAccessibilityProposalOperation(operation) {
  const includesAuthoredText = Boolean(operation && typeof operation === 'object'
    && !Array.isArray(operation) && Object.hasOwn(operation, 'authoredText'));
  if (!exactObject(operation, includesAuthoredText ? ['action', 'target', 'authoredText'] : ['action', 'target'])
    || !ACCESSIBILITY_ACTION.test(operation.action ?? '')
    || !(operation.target === null
      || (exactObject(operation.target, ['locator'])
        && LOWERCASE_SHA256.test(operation.target.locator)))) return null;
  if (!includesAuthoredText) return operation.action === 'author-image-alt-text' ? null : operation;
  const authoredText = normalizeAccessibilityAltText(operation.authoredText);
  if (operation.action !== 'author-image-alt-text' || operation.target === null || authoredText === null) return null;
  return { action: operation.action, target: operation.target, authoredText };
}

function normalizedAccessibilityProposalRequest(request) {
  if (!exactObject(request, [
    'sourceSha256', 'reviewSha256', 'expectedWorkspaceRevision', 'operations',
  ])
    || !LOWERCASE_SHA256.test(request.sourceSha256 ?? '')
    || !LOWERCASE_SHA256.test(request.reviewSha256 ?? '')
    || !Number.isSafeInteger(request.expectedWorkspaceRevision)
    || request.expectedWorkspaceRevision < 0
    || !Array.isArray(request.operations)
    || request.operations.length < 1
    || request.operations.length > 128) return null;
  const operations = request.operations.map(normalizedAccessibilityProposalOperation);
  if (operations.some((operation) => operation === null)) return null;
  return {
    sourceSha256: request.sourceSha256,
    reviewSha256: request.reviewSha256,
    expectedWorkspaceRevision: request.expectedWorkspaceRevision,
    operations,
  };
}

/** Accessibility, standards, and remediation-proposal validation transport. */
export function createValidationEndpoints({ json, text }) {
  return {
    runAccessibilityReview(documentId, options = {}) {
      if (!validAllowedOptions(options, ['profile', 'signal'])) {
        throw new TypeError('Accessibility review options are invalid.');
      }
      const { profile = 'basic-local-review', signal } = options;
      if (profile !== 'basic-local-review') {
        throw new TypeError(
          'Only the fixed basic-local-review accessibility profile is available.',
        );
      }
      return postJson(
        json,
        documentEndpointPath(documentId, '/accessibility-review'),
        { profile },
        signal,
      ).then((body) => body.report);
    },
    runStandardsValidation(documentId, profile, options = {}) {
      if (!STANDARDS_PROFILES.includes(profile) || !validSignalOptions(options)) {
        throw new TypeError('Standards validation options are invalid.');
      }
      return postJson(
        json,
        documentEndpointPath(documentId, '/standards-validation'),
        { profile },
        options.signal,
      ).then((body) => body.report);
    },
    createAccessibilityProposal(documentId, request, options = {}) {
      const normalizedRequest = normalizedAccessibilityProposalRequest(request);
      if (!normalizedRequest || !validSignalOptions(options)) {
        throw new TypeError('Accessibility proposal request is invalid.');
      }
      return postJson(
        json,
        documentEndpointPath(documentId, '/accessibility-proposal'),
        normalizedRequest,
        options.signal,
      ).then((body) => body.proposal);
    },
    exportAccessibilityProposal(documentId, proposalId, options = {}) {
      if (!ACCESSIBILITY_PROPOSAL_ID.test(proposalId ?? '')
        || !validSignalOptions(options)) {
        throw new TypeError('Accessibility proposal export options are invalid.');
      }
      return text(
        documentEndpointPath(
          documentId,
          `/accessibility-proposal?proposalId=${encodeURIComponent(proposalId)}`,
        ),
        { signal: options.signal },
      );
    },
  };
}
