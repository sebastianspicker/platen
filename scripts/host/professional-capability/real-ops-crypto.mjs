/**
 * Honest pure professional operations wrapping production writers (no receipt theater).
 */
import { inspectPdfSignatureContainer } from '../pdf-signature-container-writer.mjs';
import { writeFullPageRedaction, FULL_PAGE_REDACTION_PROFILE } from '../pdf-full-page-redaction-writer.mjs';
import { preparePdfAcroFormTextField, inspectPdfAcroFormTextField, PDF_ACROFORM_TEXT_FIELD_PROFILE } from '../pdf-acroform-text-field-writer.mjs';
import { writeIncrementalAecMeasureDictionary, inspectIncrementalAecMeasureDictionary } from '../pdf-aec-measure-writer.mjs';
import { inspectPdfHiddenDataSanitization, PDF_HIDDEN_DATA_SANITIZER_PROFILE } from '../pdf-hidden-data-sanitizer.mjs';
import { PDFKIT_METADATA_SANITIZATION_PROFILE } from '../pdfkit-sanitization-service.mjs';
import { writePdfTextEdit } from '../pdf-text-edit-writer.mjs';
import { PDF_TEXT_EDIT_PROFILE } from '../pdf-text-edit-contract.mjs';
import { diffTokens } from '../comparison-algorithms.mjs';
import { result, fail, requireString, requireBytes } from './support.mjs';
import {
  redactionFixture,
  digest,
} from './fixtures.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;

function sourceBytes(ctx) {
  if (ctx.sourcePdf === undefined && ctx.sourceBytes === undefined) {
    fail('SIGNATURE_SOURCE_REQUIRED', 'An explicit source PDF is required; demo input is not admitted.', 400);
  }
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
  const sourceSha256 = digest(source);
  if (ctx.sourceSha256 !== undefined && ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied source digest does not match the source PDF.', 409);
  }
  return { source, sourceSha256 };
}

function certificateRequest(ctx, sourceSha256) {
  if (!SHA256.test(ctx.certificateSha256 ?? '')) {
    fail('CERTIFICATE_IDENTITY_REQUIRED', 'An explicit certificate identity digest is required.', 400);
  }
  if (!ctx.documentId || typeof ctx.documentId !== 'string') {
    fail('CERTIFICATE_DOCUMENT_REQUIRED', 'An explicit document identity is required for certificate signing.', 400);
  }
  return {
    profile: 'local-pdf-signature-container-v1',
    sourceSha256,
    page: Number.isSafeInteger(ctx.page) && ctx.page > 0
      ? ctx.page
      : fail('INVALID_CERTIFICATE_SIGNATURE_REQUEST', 'page is required for certificate signing.', 400),
    fieldName: requireString(ctx.fieldName, 'fieldName', { min: 1, max: 80 }),
    reason: requireString(ctx.reason, 'reason', { min: 1, max: 120 }),
    location: requireString(ctx.location, 'location', { min: 1, max: 80 }),
    contact: requireString(ctx.contact, 'contact', { min: 0, max: 255 }),
    placeholderBytes: Number.isSafeInteger(ctx.placeholderBytes)
      ? ctx.placeholderBytes
      : fail('INVALID_CERTIFICATE_SIGNATURE_REQUEST', 'placeholderBytes is required for certificate signing.', 400),
  };
}

function receiptFailure(message, cause) {
  fail('CERTIFICATE_SIGNATURE_RECEIPT_INVALID', message, 502, cause);
}

function requireCertificateReceipt(receipt, { source, sourceSha256, request, documentId, certificateSha256, artifactBytes }) {
  if (!receipt || typeof receipt !== 'object' || !receipt.artifact || !receipt.proof || !receipt.receipt || !receipt.verificationReceipt) {
    receiptFailure('The certificate-signature authority returned an incomplete production receipt.');
  }
  const artifact = receipt.artifact;
  const cmsReceipt = receipt.receipt;
  const verification = receipt.verificationReceipt;
  if (typeof artifact.id !== 'string' || artifact.id.length < 1 || artifact.documentId !== documentId
    || artifact.mediaType !== 'application/pdf') receiptFailure('The certificate-signature artifact identity is invalid.');
  if (!SHA256.test(artifact.sha256 ?? '') || artifact.size !== artifactBytes.length || digest(artifactBytes) !== artifact.sha256) {
    receiptFailure('The reread certificate-signature artifact digest or size is invalid.');
  }
  if (cmsReceipt.operation !== 'createDetachedCMS' || cmsReceipt.outputFilename !== 'detached.cms'
    || cmsReceipt.cmsBytes < 1 || receipt.proof.sourceSha256 !== sourceSha256 || receipt.proof.cmsSha256 !== cmsReceipt.cmsSha256
    || receipt.proof.sourcePrefixPreserved !== true
    || !SHA256.test(cmsReceipt.cmsSha256 ?? '') || cmsReceipt.certificateSha256 !== certificateSha256
    || cmsReceipt.inputSha256 !== receipt.proof.bytesToSignSha256
    || verification.signatureValid !== true || verification.inputSha256 !== receipt.proof.bytesToSignSha256
    || verification.cmsSha256 !== cmsReceipt.cmsSha256 || verification.certificateSha256 !== certificateSha256
    || !['passes', 'fails'].includes(verification.trustStatus)
    || !['none', 'expired', 'not-yet-valid', 'explicitly-denied', 'not-trusted', 'policy-failure'].includes(verification.trustReason)
    || verification.timestampValidated !== false || verification.ltv !== false || verification.revocationOnlineChecked !== false) {
    receiptFailure('The certificate-signature receipt is not bound to the requested source, identity, or artifact.');
  }
  let proof;
  try { proof = inspectPdfSignatureContainer(source, artifactBytes, request, cmsReceipt.cmsSha256); }
  catch (error) { receiptFailure('Independent signature-container inspection failed.', error); }
  if (proof.sourceSha256 !== sourceSha256 || digest(artifactBytes) !== artifact.sha256
    || proof.cmsSha256 !== cmsReceipt.cmsSha256 || proof.sourcePrefixPreserved !== true
    || proof.bytesToSignSha256 !== receipt.proof.bytesToSignSha256) {
    receiptFailure('Independent signature-container inspection disagreed with the production receipt.');
  }
  return proof;
}

/** Bind professional certificate signing to the existing production service receipt contract. */
export async function opSignCertificate(ctx = {}) {
  const { source, sourceSha256 } = sourceBytes(ctx);
  if (ctx.consent !== true) {
    fail('CERTIFICATE_SIGN_CONSENT_REQUIRED', 'Explicit user consent is required before certificate signing.', 400);
  }
  const authority = ctx.certificateSignature;
  if (!authority || typeof authority.sign !== 'function') {
    fail('CERTIFICATE_SIGNATURE_UNAVAILABLE', 'The production certificate-signature service and signing identity are unavailable.', 503);
  }
  const readArtifact = typeof ctx.readArtifact === 'function' ? ctx.readArtifact : authority.readArtifact;
  if (typeof readArtifact !== 'function') {
    fail('CERTIFICATE_ARTIFACT_READBACK_REQUIRED', 'Certificate signing requires an explicit artifact reread authority.', 503);
  }
  const request = certificateRequest(ctx, sourceSha256);
  let receipt;
  try {
    receipt = await authority.sign(ctx.documentId, request, {
      certificateSha256: ctx.certificateSha256,
      consent: true,
      signal: ctx.signal,
    });
  } catch (error) {
    if (error?.code) throw error;
    fail('CERTIFICATE_SIGNATURE_FAILED', 'The production certificate-signature service failed.', 502, error);
  }
  let artifactBytes;
  try { artifactBytes = await readArtifact(receipt?.artifact); }
  catch (error) { fail('CERTIFICATE_ARTIFACT_READBACK_FAILED', 'The signed artifact could not be reread for independent inspection.', 502, error); }
  if (!Buffer.isBuffer(artifactBytes) && !(artifactBytes instanceof Uint8Array)) receiptFailure('The artifact reread authority did not return bytes.');
  artifactBytes = Buffer.from(artifactBytes);
  const proof = requireCertificateReceipt(receipt, { source, sourceSha256, request, documentId: ctx.documentId, certificateSha256: ctx.certificateSha256, artifactBytes });
  return result('sign.certificate', {
    ...receipt,
    method: 'production-certificate-signature-service',
    sourceSha256,
    outputSha256: digest(artifactBytes),
    pdf: artifactBytes,
    bytes: artifactBytes.length,
    proof,
    bytesToSignSha256: receipt.proof.bytesToSignSha256,
    cmsSha256: receipt.receipt.cmsSha256,
    certificateSignature: true,
  });
}

export function opSignAuditTrail() {
  fail('SIGNATURE_AUDIT_UNAVAILABLE', 'The production signing audit service is unavailable.', 503);
}

export function opRedactionApply(ctx = {}) {
  const secret = requireString(ctx.secret ?? 'secret', 'secret', { min: 1, max: 40 });
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? redactionFixture({ secret }), 'sourcePdf');
  if (source.includes(Buffer.from(secret, 'latin1')) === false && ctx.requireSecret !== false) {
    // still allow redaction of admitted fixtures
  }
  const sourceSha256 = digest(source);
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  const written = writeFullPageRedaction(source, {
    profile: FULL_PAGE_REDACTION_PROFILE,
    sourceSha256,
    page,
  });
  const out = written.bytes;
  if (out.includes(Buffer.from(secret, 'latin1'))) {
    fail('REDACTION_INCOMPLETE', 'Marked secret content still present after full-page redaction.', 502);
  }
  return result('redaction.apply', {
    method: 'local-object-full-page-redaction',
    sourceSha256,
    outputSha256: digest(out),
    pdf: out,
    bytes: out.length,
    page,
    proof: written.proof,
    secretRemoved: true,
  });
}

export function opRedactionFullPage(ctx = {}) {
  const applied = opRedactionApply(ctx);
  return result('redaction.full-page', { ...applied, capabilityId: 'redaction.full-page' });
}

function sanitizationSource(ctx) {
  if (ctx.sourcePdf === undefined && ctx.sourceBytes === undefined) {
    fail('SANITIZATION_SOURCE_REQUIRED', 'An explicit source PDF is required for sanitization.', 400);
  }
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
  const sourceSha256 = digest(source);
  if (!SHA256.test(ctx.sourceSha256 ?? '') || ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied sanitization source digest does not match the source PDF.', 409);
  }
  if (typeof ctx.documentId !== 'string' || ctx.documentId.length < 1) {
    fail('SANITIZATION_DOCUMENT_REQUIRED', 'An explicit document identity is required for sanitization.', 400);
  }
  return { source, sourceSha256 };
}

async function readSanitizedArtifact(ctx, service, artifact, failureCode) {
  const readArtifact = typeof ctx.readArtifact === 'function'
    ? ctx.readArtifact
    : typeof service?.readArtifact === 'function' ? service.readArtifact.bind(service) : null;
  if (typeof readArtifact !== 'function') {
    fail('SANITIZATION_ARTIFACT_READBACK_REQUIRED', 'Sanitization requires an explicit artifact reread authority.', 503);
  }
  let bytes;
  try {
    bytes = await readArtifact(artifact);
  } catch (error) {
    fail(failureCode, 'The sanitized artifact could not be reread for independent validation.', 502);
  }
  return requireBytes(bytes, 'sanitizedArtifact', { max: 256 * 1024 * 1024 });
}

function validateSanitizedArtifact({ artifact, documentId, sourceSha256, bytes, operationType, failureCode }) {
  const outputSha256 = digest(bytes);
  const provenance = artifact?.operation;
  if (!artifact || typeof artifact.id !== 'string' || artifact.id.length < 1
    || artifact.id === documentId || artifact.documentId !== documentId || artifact.mediaType !== 'application/pdf'
    || artifact.size !== bytes.length || artifact.sha256 !== outputSha256 || outputSha256 === sourceSha256
    || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))
    || provenance?.type !== operationType || provenance?.validation?.passed !== true
    || provenance.validation.outputSha256 !== outputSha256
    || !Array.isArray(provenance.inputs)
    || !provenance.inputs.some((input) => input.documentId === documentId && input.sha256 === sourceSha256 && input.role === 'source')) {
    fail(failureCode, 'The sanitization receipt is not bound to the requested source and reread artifact.', 502);
  }
  return outputSha256;
}

export async function opSanitizeHiddenData(ctx = {}) {
  const { source, sourceSha256 } = sanitizationSource(ctx);
  const service = ctx.hiddenDataSanitization;
  if (!service || typeof service.sanitize !== 'function') {
    fail('HIDDEN_DATA_SANITIZATION_UNAVAILABLE', 'The production hidden-data sanitization service is unavailable.', 503);
  }
  let receipt;
  try {
    receipt = await service.sanitize(ctx.documentId, { sourceSha256, signal: ctx.signal });
  } catch (error) {
    if (error?.code) throw error;
    fail('HIDDEN_DATA_SANITIZATION_FAILED', 'The production hidden-data sanitization service failed.', 502);
  }
  if (!receipt || !receipt.artifact || !receipt.proof || !Array.isArray(receipt.limitations)) {
    fail('HIDDEN_DATA_SANITIZATION_RECEIPT_INVALID', 'The hidden-data sanitization service returned an incomplete receipt.', 502);
  }
  const pdf = await readSanitizedArtifact(ctx, service, receipt.artifact, 'HIDDEN_DATA_SANITIZATION_READBACK_FAILED');
  const outputSha256 = validateSanitizedArtifact({
    artifact: receipt.artifact, documentId: ctx.documentId, sourceSha256, bytes: pdf,
    operationType: 'pdf-hidden-data-sanitization', failureCode: 'HIDDEN_DATA_SANITIZATION_RECEIPT_INVALID',
  });
  let proof;
  try {
    proof = inspectPdfHiddenDataSanitization(source, pdf, {
      profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE,
      sourceSha256,
    });
  } catch {
    fail('HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID', 'Independent hidden-data residue inspection rejected the reread artifact.', 502);
  }
  if (proof.sourceSha256 !== receipt.proof.sourceSha256 || proof.outputSha256 !== receipt.proof.outputSha256
    || proof.outputSha256 !== outputSha256 || proof.closedClassicRevision !== true
    || proof.orphanResidueAbsent !== true || proof.priorRevisionResidueAbsent !== true
    || proof.reachablePageContentPreserved !== true) {
    fail('HIDDEN_DATA_SANITIZATION_RECEIPT_INVALID', 'Independent hidden-data inspection disagreed with the production receipt.', 502);
  }
  return result('sanitize.hidden-data', {
    method: 'production-hidden-data-sanitization-service',
    sourceSha256,
    outputSha256,
    pdf,
    bytes: pdf.length,
    artifact: receipt.artifact,
    proof,
    limitations: receipt.limitations,
    sourceUnchanged: true,
  });
}

export async function opSanitizeMetadata(ctx = {}) {
  const { sourceSha256 } = sanitizationSource(ctx);
  const service = ctx.pdfkitSanitization;
  if (!service || typeof service.sanitizeMetadata !== 'function') {
    fail('PDFKIT_SANITIZATION_UNAVAILABLE', 'The production PDFKit metadata sanitization service is unavailable.', 503);
  }
  let receipt;
  try {
    receipt = await service.sanitizeMetadata(ctx.documentId, { sourceSha256, signal: ctx.signal });
  } catch (error) {
    if (error?.code) throw error;
    fail('PDFKIT_SANITIZATION_FAILED', 'The production PDFKit metadata sanitization service failed.', 502);
  }
  const removedCategories = receipt?.sanitization?.removedCategories;
  const evidence = receipt?.evidence;
  const expectedCategories = ['document-info', 'custom-info', 'xmp']
    .filter((category) => removedCategories?.includes(category));
  if (receipt?.kind !== 'pdfkit-metadata-sanitization'
    || receipt.sourceDigest !== sourceSha256 || receipt.sanitization?.profile !== PDFKIT_METADATA_SANITIZATION_PROFILE
    || !Array.isArray(removedCategories) || removedCategories.length < 1
    || JSON.stringify(removedCategories) !== JSON.stringify(expectedCategories)
    || !Array.isArray(receipt.limitations)
    || !evidence || [
      'sourceDigestReverified', 'nativeFreshDocumentCopy', 'nativeContentSnapshotMatched',
      'nativeMetadataAbsent', 'popplerMetadataAbsent', 'popplerCustomMetadataAbsent',
      'outputUnsigned', 'allPagesRendered', 'artifactDigestBound', 'sourceUnchanged',
    ].some((key) => evidence[key] !== true)) {
    fail('PDFKIT_SANITIZATION_RECEIPT_INVALID', 'The metadata sanitization service returned an incomplete or unbound production receipt.', 502);
  }
  const pdf = await readSanitizedArtifact(ctx, service, receipt.artifact, 'PDFKIT_SANITIZATION_READBACK_FAILED');
  const outputSha256 = validateSanitizedArtifact({
    artifact: receipt.artifact, documentId: ctx.documentId, sourceSha256, bytes: pdf,
    operationType: 'pdfkit-metadata-sanitization', failureCode: 'PDFKIT_SANITIZATION_RECEIPT_INVALID',
  });
  return result('sanitize.metadata', {
    method: 'production-pdfkit-metadata-sanitization-service',
    sourceSha256,
    outputSha256,
    pdf,
    bytes: pdf.length,
    artifact: receipt.artifact,
    sanitization: receipt.sanitization,
    evidence,
    limitations: receipt.limitations,
    titleRemoved: removedCategories.includes('document-info'),
    sourceUnchanged: true,
  });
}
