import { isDeepStrictEqual } from 'node:util';
import {
  assertIncrementalMetadataFileIdentity as assertAccessibilityFileIdentity,
  assertIncrementalMetadataRendersMatch as assertAccessibilityRendersMatch,
  assertIncrementalMetadataWorkspace as assertAccessibilityWorkspace,
  incrementalMetadataFileIdentity as accessibilityFileIdentity,
  inspectIncrementalMetadataContent as inspectAccessibilityContent,
  inspectIncrementalMetadataEnvelope as inspectAccessibilityEnvelope,
  incrementalMetadataContentMatches as accessibilityContentMatches,
  incrementalMetadataEnvelopeSupported as accessibilityEnvelopeSupported,
  readStableIncrementalMetadataOutput as readStableAccessibilityOutput,
  readStableIncrementalMetadataSource as readStableAccessibilitySource,
  writePrivateIncrementalMetadataOutput as writePrivateAccessibilityOutput,
  INCREMENTAL_METADATA_AFTER_FILES as ACCESSIBILITY_AFTER_FILES,
  INCREMENTAL_METADATA_BEFORE_FILES as ACCESSIBILITY_BEFORE_FILES,
  MAX_INCREMENTAL_METADATA_SOURCE_BYTES as MAX_INCREMENTAL_ACCESSIBILITY_SOURCE_BYTES,
} from './pdf-incremental-metadata-validation.mjs';

export {
  assertAccessibilityFileIdentity, assertAccessibilityRendersMatch, assertAccessibilityWorkspace,
  accessibilityFileIdentity, accessibilityContentMatches, accessibilityEnvelopeSupported,
  inspectAccessibilityContent, inspectAccessibilityEnvelope, readStableAccessibilityOutput,
  readStableAccessibilitySource, writePrivateAccessibilityOutput, ACCESSIBILITY_AFTER_FILES,
  ACCESSIBILITY_BEFORE_FILES, MAX_INCREMENTAL_ACCESSIBILITY_SOURCE_BYTES,
};

const PROOF_KEYS = Object.freeze(['profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved', 'priorObjectOffsetsPreserved', 'revisionCount', 'previousXrefOffset', 'appendedXrefOffset', 'catalogObjectNumber', 'catalogGeneration', 'infoObjectNumber', 'infoGeneration', 'effectiveSize', 'rootPreserved', 'idPolicy']);

function invalid(message) { const error = new Error(message); error.code = 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT'; throw error; }

export function assertAccessibilityPassiveSource(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    const error = new Error('The PDF is outside the passive accessibility metadata subset.');
    error.code = 'UNSUPPORTED_INCREMENTAL_ACCESSIBILITY_METADATA_PDF'; throw error;
  }
}

export function assertAccessibilityProof(proof, sourceLength, outputLength) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  if (keys.length !== PROOF_KEYS.length || !keys.every((key, index) => key === PROOF_KEYS[index])
    || proof.profile !== 'local-incremental-document-language-title-v1'
    || proof.sourceBytes !== sourceLength || proof.outputBytes !== outputLength
    || proof.appendedBytes !== outputLength - sourceLength || proof.appendedBytes < 1
    || proof.sourcePrefixPreserved !== true || proof.priorObjectOffsetsPreserved !== true
    || !Number.isSafeInteger(proof.revisionCount) || proof.revisionCount < 2
    || proof.revisionCount > 31
    || !Number.isSafeInteger(proof.previousXrefOffset) || proof.previousXrefOffset < 0
    || proof.previousXrefOffset >= sourceLength
    || !Number.isSafeInteger(proof.appendedXrefOffset)
    || proof.appendedXrefOffset < sourceLength || proof.appendedXrefOffset >= outputLength
    || !Number.isSafeInteger(proof.catalogObjectNumber) || proof.catalogObjectNumber < 1
    || !Number.isSafeInteger(proof.catalogGeneration) || proof.catalogGeneration < 0
    || proof.catalogGeneration > 65_535 || !Number.isSafeInteger(proof.infoObjectNumber)
    || proof.infoObjectNumber < 1 || proof.infoGeneration !== 0 || proof.effectiveSize !== proof.infoObjectNumber + 1
    || proof.catalogObjectNumber >= proof.effectiveSize
    || proof.catalogObjectNumber === proof.infoObjectNumber
    || proof.rootPreserved !== true || !['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy)) {
    invalid('The raw accessibility metadata proof did not match the fixed append-only contract.');
  }
  return proof;
}

export function accessibilityOutputMatches(source, output, request) {
  const withoutTitle = (records) => records.filter(({ name }) => name !== 'Title');
  return output.inspection.pageCount === source.inspection.pageCount
    && output.inspection.title === request.title
    && output.inspection.author === source.inspection.author
    && output.inspection.subject === source.inspection.subject
    && output.inspection.keywords === source.inspection.keywords
    && output.inspection.creator === source.inspection.creator
    && output.inspection.producer === source.inspection.producer
    && output.inspection.createdAt === source.inspection.createdAt
    && output.inspection.modifiedAt === source.inspection.modifiedAt
    && isDeepStrictEqual(withoutTitle(source.custom), withoutTitle(output.custom));
}
