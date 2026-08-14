import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  embedDetachedCms,
  getPreparedPdfSignatureBytesToSign,
  inspectPdfSignatureContainer,
  preparePdfSignatureContainer,
} from './pdf-signature-container-writer.mjs';
import { createSigningIdentityRequestPath } from './adapters/signing-identity.mjs';

export const CERTIFICATE_SIGNATURE_PROFILE = 'local-pdf-certificate-signature-v1';
export const MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_CERTIFICATE_SIGNATURE_JOB_MS = 120_000;
export const MAX_CERTIFICATE_SIGNATURE_INPUT_BYTES = 16 * 1024 * 1024;
export const CERTIFICATE_SIGNATURE_BEFORE_FILES = Object.freeze([]);
export const CERTIFICATE_SIGNATURE_AFTER_FILES = Object.freeze(['detached.cms', 'input.bin', 'output.pdf', 'request.json', 'source.pdf']);
export const CERTIFICATE_SIGNATURE_VERIFICATION_BEFORE_FILES = Object.freeze([]);
export const CERTIFICATE_SIGNATURE_VERIFICATION_AFTER_FILES = Object.freeze(['detached.cms', 'input.bin', 'request.json']);

const SHA256 = /^[0-9a-f]{64}$/u;
const PRIVATE_MODE = 0o600;
const WORKSPACE_MODE = 0o700;

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

export function throwIfCertificateSignatureAborted(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'Certificate signature processing was cancelled.', 499, signal.reason);
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function statPrivateFile(path, expectedSize = null, expectedMode = PRIVATE_MODE) {
  const pathInfo = await lstat(path, { bigint: true });
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
    || (pathInfo.mode & 0o777n) !== BigInt(expectedMode)
    || (expectedSize !== null && pathInfo.size !== BigInt(expectedSize))) {
    throw new HostError('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper produced an unsafe private file.', 502);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || (opened.mode & 0o777n) !== BigInt(expectedMode)
      || (expectedSize !== null && opened.size !== BigInt(expectedSize))
      || !sameIdentity(opened, pathInfo)) {
      throw new HostError('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper changed a private signature file while opening.', 502);
    }
    return opened;
  } finally { await handle.close(); }
}

export async function assertCertificateSignatureWorkspace(workspace, expectedFiles) {
  const info = await lstat(workspace);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== WORKSPACE_MODE) {
    throw new HostError('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper changed the private workspace.', 502);
  }
  const files = (await readdir(workspace)).sort();
  const expected = [...expectedFiles].sort();
  if (files.length !== expected.length || files.some((entry, index) => entry !== expected[index])) {
    throw new HostError('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper left unexpected files in its private workspace.', 502);
  }
}

async function writePrivateFile(path, bytes) {
  const handle = await open(path, 'wx', PRIVATE_MODE);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (result.bytesWritten < 1) throw new Error('private signature file could not be written');
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.chmod(PRIVATE_MODE);
  } finally { await handle.close(); }
  await statPrivateFile(path, bytes.length);
}

async function readStablePrivateFile(path, expectedSize, maximumBytes, expectedMode = PRIVATE_MODE) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) {
    throw new Error('private signature output is outside bounded limits');
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expectedSize) || (before.mode & 0o777n) !== BigInt(expectedMode)) {
      throw new Error('private signature output has unsafe metadata');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== expectedSize) throw new Error('private signature output length changed');
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new Error('private signature output changed during verification');
    return Object.freeze({ bytes, identity: before });
  } finally { await handle.close(); }
}

async function readStableSource(path, expectedSize, expectedSha256, expectedMode = null) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 5 || expectedSize > MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES) {
    fail('CERTIFICATE_SIGNATURE_INPUT_TOO_LARGE', 'Certificate signatures are limited to bounded PDF sources.', 413);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    const mode = before.mode & 0o777n;
    const privateMode = expectedMode === null ? (mode === 0o400n || mode === 0o600n) : mode === BigInt(expectedMode);
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expectedSize) || !privateMode) {
      fail('CERTIFICATE_SIGNATURE_SOURCE_TAMPERED', 'The immutable source PDF is not a private single-link file.', 500);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.length !== expectedSize || !sameIdentity(before, after) || digest(bytes) !== expectedSha256) {
      fail('CERTIFICATE_SIGNATURE_SOURCE_TAMPERED', 'The immutable source PDF changed while it was being read.', 500);
    }
    return Object.freeze({ bytes, identity: before });
  } finally { await handle.close(); }
}

function exactRequestJson(inputSha256, certificateSha256) {
  return Buffer.from(JSON.stringify({
    version: 1,
    operation: 'createDetachedCMS',
    inputFilename: 'input.bin',
    inputSha256,
    certificateSha256,
  }), 'utf8');
}

function exactVerificationRequestJson(inputSha256, cmsSha256, certificateSha256) {
  return Buffer.from(JSON.stringify({
    version: 1,
    operation: 'verifyDetachedCMS',
    inputFilename: 'input.bin',
    inputSha256,
    cmsFilename: 'detached.cms',
    cmsSha256,
    certificateSha256,
  }), 'utf8');
}

function receiptResult(receipt) {
  if (!receipt || receipt.version !== 1 || receipt.ok !== true || !receipt.result || typeof receipt.result !== 'object') {
    throw new Error('signing identity receipt envelope is invalid');
  }
  const result = receipt.result;
  if (result.operation !== 'createDetachedCMS' || result.outputFilename !== 'detached.cms'
    || !SHA256.test(result.certificateSha256 ?? '') || !SHA256.test(result.inputSha256 ?? '')
    || !SHA256.test(result.cmsSha256 ?? '') || !Number.isSafeInteger(result.cmsBytes)
    || result.cmsBytes < 1 || result.cmsBytes > 16 * 1024 * 1024) {
    throw new Error('signing identity receipt fields are invalid');
  }
  return result;
}

function verificationReceiptResult(receipt, { inputSha256, cmsSha256, certificateSha256 }) {
  if (!receipt || receipt.version !== 1 || receipt.ok !== true || !receipt.result || typeof receipt.result !== 'object') {
    throw new Error('signing identity verification receipt envelope is invalid');
  }
  const result = receipt.result;
  const keys = Object.keys(result).sort();
  const expectedKeys = ['certificateSha256', 'cmsSha256', 'inputSha256', 'ltv', 'operation', 'revocationOnlineChecked', 'signatureValid', 'timestampValidated', 'trustReason', 'trustStatus'].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || result.operation !== 'verifyDetachedCMS'
    || result.inputSha256 !== inputSha256 || result.cmsSha256 !== cmsSha256 || result.certificateSha256 !== certificateSha256
    || result.signatureValid !== true
    || (result.trustStatus !== 'passes' && result.trustStatus !== 'fails')
    || !['none', 'expired', 'not-yet-valid', 'explicitly-denied', 'not-trusted', 'policy-failure'].includes(result.trustReason)
    || result.timestampValidated !== false || result.ltv !== false || result.revocationOnlineChecked !== false) {
    throw new Error('signing identity verification receipt fields are invalid');
  }
  return Object.freeze({
    operation: result.operation,
    inputSha256: result.inputSha256,
    cmsSha256: result.cmsSha256,
    certificateSha256: result.certificateSha256,
    signatureValid: result.signatureValid,
    trustStatus: result.trustStatus,
    trustReason: result.trustReason,
    timestampValidated: false,
    ltv: false,
    revocationOnlineChecked: false,
  });
}

function mapHelperError(error) {
  const code = error?.code ?? '';
  if (code === 'ENGINE_CANCELLED') return new HostError('JOB_CANCELLED', 'Certificate signature processing was cancelled.', 499, { cause: error });
  if (code === 'ENGINE_TIMEOUT') return new HostError('CERTIFICATE_SIGNATURE_TIMEOUT', 'Certificate signature processing exceeded its deadline.', 504, { cause: error });
  const mappings = {
    SIGNING_IDENTITY_HELPER_UNTRUSTED: ['CERTIFICATE_SIGNATURE_HELPER_UNTRUSTED', 'The staged signing identity helper failed identity verification.', 502],
    SIGNING_IDENTITY_PLATFORM_DENIED: ['CERTIFICATE_SIGNATURE_PLATFORM_DENIED', 'The platform refused access to the selected signing identity.', 502],
    SIGNING_IDENTITY_IDENTITY_NOT_FOUND: ['CERTIFICATE_SIGNATURE_IDENTITY_NOT_FOUND', 'The selected certificate identity is not available.', 422],
    SIGNING_IDENTITY_SOURCE_MISMATCH: ['CERTIFICATE_SIGNATURE_INPUT_MISMATCH', 'The signing helper rejected the digest-bound input.', 502],
    SIGNING_IDENTITY_INPUT_TOO_LARGE: ['CERTIFICATE_SIGNATURE_INPUT_TOO_LARGE', 'The signing helper rejected an oversized input.', 413],
    SIGNING_IDENTITY_CMS_FAILED: ['CERTIFICATE_SIGNATURE_CMS_FAILED', 'The signing helper could not create a detached CMS.', 502],
    SIGNING_IDENTITY_OUTPUT_EXISTS: ['CERTIFICATE_SIGNATURE_CMS_FAILED', 'The signing helper could not create a detached CMS.', 502],
    SIGNING_IDENTITY_OUTPUT_WRITE_FAILED: ['CERTIFICATE_SIGNATURE_CMS_FAILED', 'The signing helper could not create a detached CMS.', 502],
    SIGNING_IDENTITY_HELPER_FAILED: ['CERTIFICATE_SIGNATURE_HELPER_FAILED', 'The signing identity helper failed its bounded contract.', 502],
    SIGNING_IDENTITY_UNSAFE_WORKSPACE: ['CERTIFICATE_SIGNATURE_HELPER_FAILED', 'The signing identity helper rejected its private workspace.', 502],
    SIGNING_IDENTITY_REQUEST_TOO_LARGE: ['CERTIFICATE_SIGNATURE_HELPER_PROTOCOL', 'The signing identity request exceeded the helper protocol bound.', 413],
    SIGNING_IDENTITY_RESPONSE_TOO_LARGE: ['CERTIFICATE_SIGNATURE_HELPER_PROTOCOL', 'The signing identity helper response exceeded its protocol bound.', 502],
    SIGNING_IDENTITY_RESPONSE_INVALID: ['CERTIFICATE_SIGNATURE_HELPER_PROTOCOL', 'The signing identity helper returned an invalid response.', 502],
    SIGNING_IDENTITY_CMS_INVALID: ['CERTIFICATE_SIGNATURE_VERIFICATION_FAILED', 'The detached CMS did not pass cryptographic verification.', 422],
    SIGNING_IDENTITY_CMS_MULTIPLE_SIGNERS: ['CERTIFICATE_SIGNATURE_VERIFICATION_FAILED', 'The detached CMS contains more than one signer.', 422],
    SIGNING_IDENTITY_TRUST_INDETERMINATE: ['CERTIFICATE_SIGNATURE_TRUST_INDETERMINATE', 'The local offline certificate trust evaluation was indeterminate.', 502],
  };
  const mapped = mappings[code];
  return mapped ? new HostError(mapped[0], mapped[1], mapped[2], { cause: error }) : null;
}

async function verifyCertificateSignatureCms({ store, adapter, documentId, certificateSha256, deadline, lifecycle, inputBytes, inputSha256, cmsBytes, cmsSha256 }) {
  throwIfCertificateSignatureAborted(deadline.signal);
  const workspace = await store.createJobWorkspace(documentId);
  lifecycle.verificationWorkspace = workspace;
  await assertCertificateSignatureWorkspace(workspace, CERTIFICATE_SIGNATURE_VERIFICATION_BEFORE_FILES);
  const inputPath = join(workspace, 'input.bin');
  const cmsPath = join(workspace, 'detached.cms');
  const requestPath = createSigningIdentityRequestPath(workspace);
  const requestBytes = exactVerificationRequestJson(inputSha256, cmsSha256, certificateSha256);
  await writePrivateFile(inputPath, inputBytes);
  await writePrivateFile(cmsPath, cmsBytes);
  await writePrivateFile(requestPath, requestBytes);
  await assertCertificateSignatureWorkspace(workspace, CERTIFICATE_SIGNATURE_VERIFICATION_AFTER_FILES);
  const inputIdentity = await statPrivateFile(inputPath, inputBytes.length);
  const cmsIdentity = await statPrivateFile(cmsPath, cmsBytes.length);
  const requestIdentity = await statPrivateFile(requestPath, requestBytes.length);
  throwIfCertificateSignatureAborted(deadline.signal);
  let rawReceipt;
  try {
    rawReceipt = await adapter.verifyDetachedCms({ workspacePath: workspace, requestPath }, { signal: deadline.signal, timeoutMs: 30_000 });
  } catch (error) {
    const mapped = mapHelperError(error);
    if (mapped) throw mapped;
    fail('CERTIFICATE_SIGNATURE_VERIFICATION_FAILED', 'The detached CMS failed offline verification.', 422, error);
  }
  await assertCertificateSignatureWorkspace(workspace, CERTIFICATE_SIGNATURE_VERIFICATION_AFTER_FILES);
  for (const [path, expectedSize, identity] of [[inputPath, inputBytes.length, inputIdentity], [cmsPath, cmsBytes.length, cmsIdentity], [requestPath, requestBytes.length, requestIdentity]]) {
    const after = await statPrivateFile(path, expectedSize);
    if (!sameIdentity(identity, after)) fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The detached CMS verification workspace changed during verification.', 502);
  }
  let inputRead; let cmsRead; let requestRead;
  try {
    [inputRead, cmsRead, requestRead] = await Promise.all([
      readStablePrivateFile(inputPath, inputBytes.length, MAX_CERTIFICATE_SIGNATURE_INPUT_BYTES),
      readStablePrivateFile(cmsPath, cmsBytes.length, 16 * 1024 * 1024),
      readStablePrivateFile(requestPath, requestBytes.length, 64 * 1024),
    ]);
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The detached CMS verification workspace changed during verification.', 502, error);
  }
  if (digest(inputRead.bytes) !== inputSha256 || digest(cmsRead.bytes) !== cmsSha256 || !requestRead.bytes.equals(requestBytes)) {
    fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The detached CMS verification workspace bytes changed during verification.', 502);
  }
  throwIfCertificateSignatureAborted(deadline.signal);
  try {
    return verificationReceiptResult(rawReceipt, { inputSha256, cmsSha256, certificateSha256 });
  } catch (error) {
    fail('CERTIFICATE_SIGNATURE_VERIFICATION_FAILED', 'The detached CMS failed offline verification.', 422, error);
  }
}

export async function runCertificateSignatureJob({ store, adapter, documentId, source, request, certificateSha256, deadline, lifecycle }) {
  throwIfCertificateSignatureAborted(deadline.signal);
  await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId);
  lifecycle.workspace = workspace;
  await assertCertificateSignatureWorkspace(workspace, CERTIFICATE_SIGNATURE_BEFORE_FILES);
  const sourceCopyPath = join(workspace, 'source.pdf');
  const sourceCopyIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourceCopyPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES, signal: deadline.signal });
  await assertCertificateSignatureWorkspace(workspace, ['source.pdf']);
  const sourceRead = await readStableSource(sourceCopyPath, source.size, source.sha256);
  await assertPrivateSourceCopy({ path: sourceCopyPath, identity: sourceCopyIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES });
  const prepared = preparePdfSignatureContainer(sourceRead.bytes, request);
  const bytesToSign = getPreparedPdfSignatureBytesToSign(prepared);
  if (bytesToSign.length > MAX_CERTIFICATE_SIGNATURE_INPUT_BYTES) fail('CERTIFICATE_SIGNATURE_INPUT_TOO_LARGE', 'The digest-bound signing input exceeds the native helper limit.', 413);
  const inputSha256 = digest(bytesToSign);
  if (inputSha256 !== prepared.proof.bytesToSignSha256) fail('CERTIFICATE_SIGNATURE_OUTPUT_INVALID', 'The signature-container authority returned an inconsistent bytes-to-sign digest.');
  const inputPath = join(workspace, 'input.bin');
  const requestPath = createSigningIdentityRequestPath(workspace);
  const requestBytes = exactRequestJson(inputSha256, certificateSha256);
  await writePrivateFile(inputPath, bytesToSign);
  await writePrivateFile(requestPath, requestBytes);
  await assertCertificateSignatureWorkspace(workspace, ['input.bin', 'request.json', 'source.pdf']);
  const inputIdentity = await statPrivateFile(inputPath, bytesToSign.length);
  const requestIdentity = await statPrivateFile(requestPath, requestBytes.length);
  throwIfCertificateSignatureAborted(deadline.signal);
  if (!adapter || typeof adapter.createDetachedCms !== 'function' || typeof adapter.verifyDetachedCms !== 'function') fail('CERTIFICATE_SIGNATURE_ADAPTER_UNAVAILABLE', 'The staged signing identity adapter is unavailable.', 503);
  let receipt;
  try { receipt = receiptResult(await adapter.createDetachedCms({ workspacePath: workspace, requestPath }, { signal: deadline.signal, timeoutMs: 30_000 })); }
  catch (error) { throw mapHelperError(error) ?? error; }
  await assertCertificateSignatureWorkspace(workspace, ['detached.cms', 'input.bin', 'request.json', 'source.pdf']);
  const inputAfter = await statPrivateFile(inputPath, bytesToSign.length);
  const requestAfter = await statPrivateFile(requestPath, requestBytes.length);
  if (!sameIdentity(inputIdentity, inputAfter) || !sameIdentity(requestIdentity, requestAfter)) fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper changed its immutable input or request.', 502);
  let inputDigest; let requestDigest;
  try {
    [inputDigest, requestDigest] = await Promise.all([
      readStablePrivateFile(inputPath, bytesToSign.length, MAX_CERTIFICATE_SIGNATURE_INPUT_BYTES),
      readStablePrivateFile(requestPath, requestBytes.length, 64 * 1024),
    ]);
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper changed its input or exact request.', 502, error);
  }
  if (digest(inputDigest.bytes) !== inputSha256 || !requestDigest.bytes.equals(requestBytes)) fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The signing helper changed its input or exact request.', 502);
  if (receipt.certificateSha256 !== certificateSha256 || receipt.inputSha256 !== inputSha256) fail('CERTIFICATE_SIGNATURE_INPUT_MISMATCH', 'The signing helper receipt is not bound to the requested certificate and input.', 502);
  let cmsRead;
  try { cmsRead = await readStablePrivateFile(join(workspace, 'detached.cms'), receipt.cmsBytes, 16 * 1024 * 1024); }
  catch (error) { fail('CERTIFICATE_SIGNATURE_CMS_FAILED', 'The detached CMS output could not be read safely.', 502, error); }
  if (digest(cmsRead.bytes) !== receipt.cmsSha256) fail('CERTIFICATE_SIGNATURE_CMS_FAILED', 'The detached CMS output digest did not match its helper receipt.', 502);
  const verificationReceipt = await verifyCertificateSignatureCms({
    store, adapter, documentId, certificateSha256, deadline, lifecycle,
    inputBytes: bytesToSign, inputSha256, cmsBytes: cmsRead.bytes, cmsSha256: receipt.cmsSha256,
  });
  const final = embedDetachedCms(prepared, cmsRead.bytes);
  const outputPath = join(workspace, 'output.pdf');
  await writePrivateFile(outputPath, final.bytes);
  await assertCertificateSignatureWorkspace(workspace, CERTIFICATE_SIGNATURE_AFTER_FILES);
  let outputRead;
  try { outputRead = await readStablePrivateFile(outputPath, final.bytes.length, MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES + 512 * 1024); }
  catch (error) { fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The signature output could not be read safely.', 502, error); }
  if (!outputRead.bytes.equals(final.bytes)) fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The signature output changed before independent inspection.', 502);
  const proof = inspectPdfSignatureContainer(sourceRead.bytes, outputRead.bytes, request, receipt.cmsSha256);
  if (proof.sourceSha256 !== source.sha256 || proof.bytesToSignSha256 !== inputSha256
    || !proof.sourcePrefixPreserved || proof.cmsSha256 !== receipt.cmsSha256
    || proof.byteRange.length !== prepared.proof.byteRange.length
    || proof.byteRange.some((value, index) => value !== prepared.proof.byteRange[index])) {
    fail('CERTIFICATE_SIGNATURE_OUTPUT_INVALID', 'Independent signature-container inspection disagreed with the authority proof.', 502);
  }
  const outputAfter = await statPrivateFile(outputPath, final.bytes.length);
  if (!sameIdentity(outputRead.identity, outputAfter)) fail('CERTIFICATE_SIGNATURE_TAMPERED', 'The signature output changed during independent inspection.', 502);
  await assertPrivateSourceCopy({ path: sourceCopyPath, identity: sourceCopyIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES });
  const sourceAgain = await readStableSource(store.getSourcePath(documentId), source.size, source.sha256);
  if (!sourceAgain.bytes.equals(sourceRead.bytes)) fail('CERTIFICATE_SIGNATURE_SOURCE_TAMPERED', 'The immutable source PDF changed during signing.', 500);
  await store.verifySource(documentId);
  throwIfCertificateSignatureAborted(deadline.signal);
  const outputDigest = digest(outputRead.bytes);
  const provenance = createOperationProvenance({
    type: 'pdf-certificate-signature',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: CERTIFICATE_SIGNATURE_PROFILE, certificateSha256, requestSha256: digest(requestBytes), page: request.page, placeholderBytes: request.placeholderBytes },
    expected: { sourcePrefixPreserved: true, byteRangeSha256: inputSha256, cmsSha256: receipt.cmsSha256, signatureValid: true, trustStatus: verificationReceipt.trustStatus, trustReason: verificationReceipt.trustReason, trustValidated: verificationReceipt.trustStatus === 'passes', timestamped: false, timestampValidated: false, ltv: false, certified: false, verificationReceipt },
    validation: { passed: true, validators: ['source-sha256', 'private-workspace', 'pinned-signing-helper', 'request-digest', 'input-digest', 'cms-digest', 'offline-detached-cms-verification', 'signature-container-independent-inspection', 'source-prefix', 'byte-range', 'artifact-sha256'], outputSha256: outputDigest },
  });
  lifecycle.promotedArtifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'signed-document.pdf', operation: provenance, expectedSha256: outputDigest, signal: deadline.signal });
  if (lifecycle.promotedArtifact.sha256 !== outputDigest || lifecycle.promotedArtifact.id === source.id) fail('CERTIFICATE_SIGNATURE_OUTPUT_INVALID', 'The promoted signed PDF artifact does not match the independently inspected output.', 502);
  lifecycle.completed = true;
  const limitations = verificationReceipt.trustStatus === 'passes'
    ? ['This is a cryptographic detached CMS container signed by the selected local identity.', 'Current local X.509 trust evaluation passed with network fetching disabled; timestamps, LTV, revocation freshness, and certification are not established by this operation.']
    : ['This is a cryptographic detached CMS container signed by the selected local identity.', `Current local X.509 trust evaluation failed (${verificationReceipt.trustReason}); the signature remains cryptographically valid and is not promoted as trusted. Timestamps, LTV, revocation freshness, and certification are not established by this operation.`];
  return Object.freeze({ artifact: lifecycle.promotedArtifact, proof, receipt, verificationReceipt, limitations: Object.freeze(limitations) });
}

export async function cleanupCertificateSignatureJob({ store, lifecycle }) {
  let workspaceError = null;
  let artifactError = null;
  const workspaces = [...new Set([lifecycle.workspace, lifecycle.verificationWorkspace].filter(Boolean))];
  for (const workspace of workspaces) {
    try { await store.cleanupJob(workspace); } catch (error) { workspaceError ??= error; }
  }
  if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; }
  }
  if (workspaceError || artifactError) {
    const cause = workspaceError && artifactError ? new AggregateError([workspaceError, artifactError], 'certificate signature cleanup had multiple failures') : workspaceError ?? artifactError;
    throw new HostError('CERTIFICATE_SIGNATURE_CLEANUP_FAILED', 'Certificate signature processing could not clean its private workspace or revoke its promoted artifact.', 500, { cause });
  }
}
