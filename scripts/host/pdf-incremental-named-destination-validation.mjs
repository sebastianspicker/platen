import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { parseNamedDestinations } from './pdf-service-foundation.mjs';
import { incrementalMetadataRunOptions } from './pdf-incremental-metadata-validation.mjs';
import {
  GOTO_LINK_AFTER_FILES as NAMED_DESTINATION_AFTER_FILES,
  GOTO_LINK_BEFORE_FILES as NAMED_DESTINATION_BEFORE_FILES,
  MAX_INCREMENTAL_GOTO_LINK_OUTPUT_BYTES as MAX_INCREMENTAL_NAMED_DESTINATION_OUTPUT_BYTES,
  MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES as MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES,
  assertGoToLinkWorkspace,
  assertIncrementalGoToLinkFileIdentity,
  assertIncrementalGoToLinkRendersMatch,
  incrementalGoToLinkContentMatches as incrementalNamedDestinationContentMatches,
  incrementalGoToLinkEnvelopeMatches as incrementalNamedDestinationEnvelopeMatches,
  incrementalGoToLinkEnvelopeSupported as incrementalNamedDestinationEnvelopeSupported,
  incrementalGoToLinkFileIdentity as incrementalNamedDestinationFileIdentity,
  inspectIncrementalGoToLinkContent,
  inspectIncrementalGoToLinkEnvelope,
  readStableIncrementalGoToLink,
  writePrivateIncrementalGoToLinkOutput,
} from './pdf-incremental-goto-link-validation.mjs';

const PROOF_KEYS = Object.freeze(['profile', 'sourceBytes', 'outputBytes', 'sourcePrefixPreserved', 'revisionCount', 'previousXrefOffset', 'appendedXrefOffset', 'targetPage', 'targetPageObjectNumber', 'targetPageGeneration', 'nameSha256', 'effectiveSize', 'rootPreserved', 'infoPreserved', 'idPolicy']);
const SHARED_ERROR_CODES = Object.freeze({
  INCREMENTAL_GOTO_LINK_OUTPUT_INVALID: 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID',
  INCREMENTAL_GOTO_LINK_POPPLER_WARNING: 'INCREMENTAL_NAMED_DESTINATION_POPPLER_WARNING',
  INCREMENTAL_GOTO_LINK_WORKSPACE_INVALID: 'INCREMENTAL_NAMED_DESTINATION_WORKSPACE_INVALID',
  INCREMENTAL_METADATA_OUTPUT_INVALID: 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID',
  INCREMENTAL_METADATA_POPPLER_WARNING: 'INCREMENTAL_NAMED_DESTINATION_POPPLER_WARNING',
  INCREMENTAL_METADATA_WORKSPACE_INVALID: 'INCREMENTAL_NAMED_DESTINATION_WORKSPACE_INVALID',
});

function fail(code, message, status = 502) { throw new HostError(code, message, status); }
function silent(result) { if (String(result?.stderr ?? '').trim()) fail('INCREMENTAL_NAMED_DESTINATION_POPPLER_WARNING', 'Poppler reported a warning while validating the incremental named-destination PDF.', 422); }
async function namedDestinationBoundary(operation) {
  try { return await operation(); } catch (error) {
    const code = SHARED_ERROR_CODES[error?.code];
    if (!code) throw error;
    throw new HostError(
      code,
      'Incremental named-destination validation rejected shared engine evidence.',
      error.status,
      { cause: error },
    );
  }
}

export function inspectIncrementalNamedDestinationEnvelope(...args) {
  return namedDestinationBoundary(() => inspectIncrementalGoToLinkEnvelope(...args));
}

export function inspectIncrementalNamedDestinationContent(...args) {
  return namedDestinationBoundary(() => inspectIncrementalGoToLinkContent(...args));
}

export function assertNamedDestinationWorkspace(...args) {
  return namedDestinationBoundary(() => assertGoToLinkWorkspace(...args));
}

export function assertIncrementalNamedDestinationFileIdentity(...args) {
  return namedDestinationBoundary(() => assertIncrementalGoToLinkFileIdentity(...args));
}

export function assertIncrementalNamedDestinationRendersMatch(...args) {
  return namedDestinationBoundary(() => assertIncrementalGoToLinkRendersMatch(...args));
}

export function readStableIncrementalNamedDestination(...args) {
  return namedDestinationBoundary(() => readStableIncrementalGoToLink(...args));
}

export function writePrivateIncrementalNamedDestinationOutput(...args) {
  return namedDestinationBoundary(() => writePrivateIncrementalGoToLinkOutput(...args));
}

export function assertIncrementalNamedDestinationProof(proof, sourceLength, outputLength, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const valid = keys.length === PROOF_KEYS.length && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === request.profile && proof.sourceBytes === sourceLength && proof.outputBytes === outputLength
    && proof.sourcePrefixPreserved === true && Number.isSafeInteger(proof.revisionCount)
    && proof.revisionCount >= 2 && proof.revisionCount <= 32
    && Number.isSafeInteger(proof.previousXrefOffset) && proof.previousXrefOffset > 0 && proof.previousXrefOffset < sourceLength
    && Number.isSafeInteger(proof.appendedXrefOffset) && proof.appendedXrefOffset >= sourceLength && proof.appendedXrefOffset < outputLength
    && proof.targetPage === request.targetPage
    && Number.isSafeInteger(proof.targetPageObjectNumber) && proof.targetPageObjectNumber > 0
    && Number.isSafeInteger(proof.targetPageGeneration)
    && proof.targetPageGeneration >= 0 && proof.targetPageGeneration <= 65_535
    && proof.nameSha256 === createHash('sha256').update(request.name, 'ascii').digest('hex')
    && Number.isSafeInteger(proof.effectiveSize) && proof.effectiveSize > proof.targetPageObjectNumber
    && proof.rootPreserved === true && proof.infoPreserved === true && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'The raw incremental named-destination proof did not match the fixed append-only contract.');
  return proof;
}

export async function inspectNamedDestinationInventory(poppler, input, workspace, signal, pageCount) {
  const result = await poppler.execute('inspectDestinations', { input }, incrementalMetadataRunOptions(workspace, signal));
  silent(result);
  return parseNamedDestinations(result.stdout, { pageCount });
}

export function assertSourceNamedDestinationInventory(inventory) {
  if (inventory.truncated || inventory.items.length !== 0) fail('INCREMENTAL_NAMED_DESTINATION_SOURCE_UNSUPPORTED', 'Incremental named destinations require an exact empty source named-destination inventory.', 422);
}

export function assertOutputNamedDestinationInventory(inventory, request) {
  const item = inventory.items[0];
  if (inventory.truncated || inventory.items.length !== 1 || item?.page !== request.targetPage
    || item.name !== request.name || !/^\[\s*Fit\s*\]$/.test(item.destination)) {
    fail('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'Poppler did not report exactly the requested /Fit named destination.');
  }
}

export { NAMED_DESTINATION_AFTER_FILES, NAMED_DESTINATION_BEFORE_FILES, MAX_INCREMENTAL_NAMED_DESTINATION_OUTPUT_BYTES, MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES, incrementalNamedDestinationContentMatches, incrementalNamedDestinationEnvelopeMatches, incrementalNamedDestinationEnvelopeSupported, incrementalNamedDestinationFileIdentity };
