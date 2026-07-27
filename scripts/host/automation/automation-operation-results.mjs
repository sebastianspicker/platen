import { createHash } from 'node:crypto';
import { HostError } from '../host-error.mjs';
import { MAX_OCR_BATCH_BYTES, MAX_PAGE_COUNT } from '../pdf-service-limits.mjs';
import { validateOcrDocumentResult } from '../../../src/core/ocr-contract.js';
import { validateFullPageRedactionBatchResult, validateFullPageRedactionResult } from '../../../src/core/pdf-full-page-redaction-contract.js';
import { OUTPUT_INTENT_PROFILE } from '../prepress/output-intent-contract.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
  MAX_FULL_PAGE_REDACTION_PAGE, MAX_FULL_PAGE_REDACTION_PAGES, OPAQUE_ID, SHA256,
} from './automation-operation-contract.mjs';

const MAX_AUTOMATION_OUTPUT_BYTES = 512 * 1024 * 1024;

function evidenceBoolean(value, { extendedYes = false } = {}) {
  if (value === 'no') return false;
  if (value === 'yes' || (extendedYes && /^yes(?:\s|$)/u.test(value))) return true;
  if (value === 'unknown') return null;
  throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation inspection evidence is invalid.', 502);
}

export function inspectionReceipt(source, inspected) {
  if (!inspected || !Number.isSafeInteger(inspected.pageCount)
    || inspected.pageCount < 1 || inspected.pageCount > MAX_PAGE_COUNT
    || (inspected.pdfVersion !== null
      && !/^(?:1[.][0-7]|2[.]0)$/u.test(inspected.pdfVersion))) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation inspection evidence is invalid.', 502);
  }
  return Object.freeze({
    schemaVersion: 1, operation: AUTOMATION_INSPECT_TYPE,
    sourceSha256: source.sha256, sourceBytes: source.size,
    pageCount: inspected.pageCount, pdfVersion: inspected.pdfVersion,
    encrypted: evidenceBoolean(inspected.encrypted, { extendedYes: true }),
    tagged: evidenceBoolean(inspected.tagged),
    optimized: evidenceBoolean(inspected.optimized),
  });
}

export function validatedOcrOutput(source, options, output, documentId) {
  let checked;
  try { checked = validateOcrDocumentResult(output); } catch (error) {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID', 'Automation OCR evidence is invalid.', 502, { cause: error },
    );
  }
  const { artifact, result } = checked;
  const expectedDictionary = Object.freeze({
    termCount: options.userDictionary.length,
    digest: options.userDictionary.length > 0
      ? createHash('sha256').update(`${options.userDictionary.join('\n')}\n`, 'utf8').digest('hex')
      : null,
  });
  if (checked.sourceDigest !== source.sha256
    || artifact.documentId !== documentId
    || result.language !== options.language
    || result.cleanupPreset !== options.cleanupPreset
    || result.segmentation !== options.segmentation
    || JSON.stringify(result.userDictionary) !== JSON.stringify(expectedDictionary)
    || JSON.stringify(artifact.operation?.parameters?.userDictionary)
      !== JSON.stringify(result.userDictionary)
    || !OPAQUE_ID.test(artifact.id ?? '') || artifact.mediaType !== 'application/pdf'
    || !SHA256.test(artifact.sha256 ?? '')
    || !Number.isSafeInteger(artifact.size) || artifact.size < 1
    || artifact.size > MAX_OCR_BATCH_BYTES
    || checked.evidence.sourceBound !== true || checked.evidence.localOnly !== true) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation OCR evidence is invalid.', 502);
  }
  return checked;
}

export function ocrReceipt(source, options, checked, durableOutput) {
  const { result } = checked;
  if (!durableOutput || !OPAQUE_ID.test(durableOutput.id ?? '')
    || durableOutput.sha256 !== checked.artifact.sha256
    || durableOutput.size !== checked.artifact.size
    || durableOutput.sourceId !== source.id
    || durableOutput.sourceSha256 !== source.sha256) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation OCR durable output is invalid.', 502);
  }
  return Object.freeze({
    schemaVersion: 1, operation: AUTOMATION_OCR_TYPE,
    sourceSha256: source.sha256, sourceBytes: source.size,
    language: options.language, cleanupPreset: options.cleanupPreset,
    segmentation: options.segmentation,
    userDictionaryEvidence: Object.freeze({ ...result.userDictionary }),
    pageCount: result.pageCount, recognizedWordCount: result.recognizedWordCount,
    durableOutput: Object.freeze({
      id: durableOutput.id, size: durableOutput.size, sha256: durableOutput.sha256,
    }),
    sourceBound: true, localOnly: true,
    limitations: Object.freeze([
      'The searchable OCR PDF is retained only in private local automation output storage.',
    ]),
  });
}

export function validatedOutputIntent(source, output, documentId) {
  const artifact = output?.artifact;
  const profile = output?.profile;
  const proof = output?.proof;
  const receipt = output?.receipt;
  const operation = artifact?.operation;
  if (!output || Object.getPrototypeOf(output) !== Object.prototype
    || output.kind !== 'output-intent-artifact' || output.schemaVersion !== 1
    || output.authoritative !== false || output.sourceDigest !== source.sha256
    || !artifact || artifact.documentId !== documentId
    || !OPAQUE_ID.test(artifact.id ?? '') || artifact.mediaType !== 'application/pdf'
    || !SHA256.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.size)
    || artifact.size < 5 || artifact.size > MAX_AUTOMATION_OUTPUT_BYTES
    || profile?.id !== 'ghostscript-default-cmyk' || profile?.colorSpace !== 'CMYK'
    || !SHA256.test(profile?.sha256 ?? '') || !Number.isSafeInteger(profile?.size)
    || profile.size < 132 || profile.size > 4 * 1024 * 1024
    || proof?.schema !== 'pdf-output-intent-assignment-proof-v1' || proof?.version !== 1
    || proof.sourceSha256 !== source.sha256 || proof.outputSha256 !== artifact.sha256
    || proof.profileSha256 !== profile.sha256 || proof.profileBytes !== profile.size
    || proof.outputIntentCount !== 1 || proof.closedClassicRevision !== true
    || receipt?.outputSha256 !== artifact.sha256
    || !Number.isSafeInteger(receipt?.pageCount) || receipt.pageCount < 1
    || receipt.pageCount > MAX_PAGE_COUNT || receipt.outputIntentCount !== 1
    || receipt.pageGeometryPreserved !== true
    || receipt.textExtractionEquivalent !== true || receipt.everyPageRendered !== true
    || receipt.pdfXValidated !== false
    || operation?.type !== 'ghostscript-cmyk-output-intent'
    || operation.inputs?.length !== 1
    || operation.inputs[0]?.documentId !== documentId
    || operation.inputs[0]?.sha256 !== source.sha256
    || operation.parameters?.profileId !== profile.id
    || operation.parameters?.profileSha256 !== profile.sha256
    || operation.parameters?.profileBytes !== profile.size
    || operation.expected?.outputIntentCount !== 1
    || operation.expected?.embeddedProfileSha256 !== profile.sha256
    || operation.validation?.outputSha256 !== artifact.sha256
    || operation.validation?.profileSha256 !== profile.sha256
    || operation.validation?.outputIntentCount !== 1) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation OutputIntent evidence is invalid.', 502);
  }
  return Object.freeze({ artifact, profile, proof, receipt });
}

export function validatedFullPageRedaction(source, output, documentId, sourceSha256) {
  if (!output || Object.getPrototypeOf(output) !== Object.prototype
    || output.kind !== 'pdf-full-page-redaction' || output.sourceDigest !== sourceSha256
    || output.artifact?.documentId !== documentId) {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID', 'Automation full-page redaction output is invalid.', 502,
    );
  }
  return validateFullPageRedactionResult(output, {
    documentId,
    sourceSha256,
    request: { page: output.redaction?.page ?? NaN },
  });
}

export function validatedFullPageRedactionBatch(source, output, documentId, sourceSha256, pages) {
  if (!output || Object.getPrototypeOf(output) !== Object.prototype || output.sourceDigest !== sourceSha256 || output.artifact?.documentId !== documentId) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation full-page redaction batch output is invalid.', 502);
  }
  return validateFullPageRedactionBatchResult(output, { documentId, sourceSha256, request: { pages } });
}

export function fullPageRedactionReceipt(source, pages, checked, durableOutput) {
  if (!durableOutput || !Array.isArray(pages) || pages.length < 1
    || pages.length > MAX_FULL_PAGE_REDACTION_PAGES
    || pages.some((page, index) => !Number.isSafeInteger(page)
      || page < 1 || page > MAX_FULL_PAGE_REDACTION_PAGE
      || (index > 0 && page <= pages[index - 1]))
    || (checked?.kind === 'pdf-full-page-redaction-batch'
      ? !Array.isArray(checked.pages) || checked.pages.length !== pages.length || checked.pages.some((page, index) => page !== pages[index])
      : checked?.redaction?.page !== pages[pages.length - 1])
    || !OPAQUE_ID.test(durableOutput.id ?? '')) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation full-page redaction durable output is invalid.', 502);
  }
  if (durableOutput.sha256 !== checked.artifact.sha256
    || durableOutput.size !== checked.artifact.size
    || durableOutput.sourceId !== source.id
    || durableOutput.sourceSha256 !== source.sha256) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation full-page redaction durable output is invalid.', 502);
  }
  return Object.freeze({
    schemaVersion: 1, operation: AUTOMATION_FULL_PAGE_REDACTION_TYPE,
    sourceSha256: source.sha256, sourceBytes: source.size,
    pages: Object.freeze([...pages]),
    durableOutput: Object.freeze({
      id: durableOutput.id,
      size: durableOutput.size,
      sha256: durableOutput.sha256,
    }),
    sourceBound: true,
    localOnly: true,
  });
}

export function outputIntentReceipt(source, checked, durableOutput) {
  if (!durableOutput || !OPAQUE_ID.test(durableOutput.id ?? '')
    || durableOutput.sha256 !== checked.artifact.sha256
    || durableOutput.size !== checked.artifact.size
    || durableOutput.sourceId !== source.id
    || durableOutput.sourceSha256 !== source.sha256) {
    throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation OutputIntent durable output is invalid.', 502);
  }
  return Object.freeze({
    schemaVersion: 1, operation: AUTOMATION_OUTPUT_INTENT_TYPE,
    sourceSha256: source.sha256, sourceBytes: source.size,
    profile: OUTPUT_INTENT_PROFILE,
    profileEvidence: Object.freeze({
      id: checked.profile.id, colorSpace: checked.profile.colorSpace,
      size: checked.profile.size, sha256: checked.profile.sha256,
    }),
    pageCount: checked.receipt.pageCount, outputIntentCount: 1,
    durableOutput: Object.freeze({
      id: durableOutput.id, size: durableOutput.size, sha256: durableOutput.sha256,
    }),
    sourceBound: true, localOnly: true, authoritative: false, pdfXValidated: false,
    limitations: Object.freeze([
      'The fixed OutputIntent assignment does not establish PDF/X or press certification.',
    ]),
  });
}
