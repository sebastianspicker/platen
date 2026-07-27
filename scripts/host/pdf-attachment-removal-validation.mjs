import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import {
  MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES,
  PDF_JAVASCRIPT_REMOVAL_AFTER_FILES,
  PDF_JAVASCRIPT_REMOVAL_BEFORE_FILES,
  assertPdfJavaScriptRemovalFileIdentity,
  assertPdfJavaScriptRemovalRendersMatch,
  assertPdfJavaScriptRemovalWorkspace,
  inspectPdfJavaScriptRemovalContent,
  inspectPdfJavaScriptRemovalEnvelope,
  pdfJavaScriptRemovalContentMatches,
  pdfJavaScriptRemovalFileIdentity,
  readStablePdfJavaScriptRemoval,
  writePrivatePdfJavaScriptRemovalOutput,
} from './pdf-javascript-removal-validation.mjs';

export const MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES =
  MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES;
export const PDF_ATTACHMENT_REMOVAL_BEFORE_FILES =
  PDF_JAVASCRIPT_REMOVAL_BEFORE_FILES;
export const PDF_ATTACHMENT_REMOVAL_AFTER_FILES =
  PDF_JAVASCRIPT_REMOVAL_AFTER_FILES;
export const pdfAttachmentRemovalFileIdentity = pdfJavaScriptRemovalFileIdentity;

const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'sourceSha256', 'outputSha256',
  'nameSha256', 'contentSha256', 'contentBytes', 'removedObjectCount',
  'closedClassicRevision', 'priorRevisionsAbsent', 'attachmentSurfacesAbsent',
  'removedReferencesUnresolvable', 'rootPreserved', 'infoPreserved', 'idPolicy',
]);
const STABLE_INSPECTION_FIELDS = Object.freeze([
  'pageCount', 'title', 'author', 'subject', 'keywords', 'creator', 'producer',
  'createdAt', 'modifiedAt', 'tagged', 'userProperties', 'suspects', 'form',
  'javascript', 'encrypted', 'pageSize', 'pageRotation', 'optimized', 'pdfVersion',
]);
const SHARED_ERRORS = Object.freeze({
  PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID: 'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
  PDF_JAVASCRIPT_REMOVAL_POPPLER_WARNING: 'PDF_ATTACHMENT_REMOVAL_POPPLER_WARNING',
  PDF_JAVASCRIPT_REMOVAL_WORKSPACE_INVALID: 'PDF_ATTACHMENT_REMOVAL_WORKSPACE_INVALID',
});

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

async function attachmentBoundary(operation) {
  try {
    return await operation();
  } catch (error) {
    const code = SHARED_ERRORS[error?.code];
    if (!code) throw error;
    return fail(
      code,
      'Attachment-removal private validation rejected shared engine evidence.',
      error.status,
      error,
    );
  }
}

export function assertPdfAttachmentRemovalWorkspace(...args) {
  return attachmentBoundary(() => assertPdfJavaScriptRemovalWorkspace(...args));
}

export function assertPdfAttachmentRemovalFileIdentity(...args) {
  return attachmentBoundary(() => assertPdfJavaScriptRemovalFileIdentity(...args));
}

export function assertPdfAttachmentRemovalRendersMatch(...args) {
  return attachmentBoundary(() => assertPdfJavaScriptRemovalRendersMatch(...args));
}

export function inspectPdfAttachmentRemovalContent(...args) {
  return attachmentBoundary(() => inspectPdfJavaScriptRemovalContent(...args));
}

export function inspectPdfAttachmentRemovalEnvelope(...args) {
  return attachmentBoundary(() => inspectPdfJavaScriptRemovalEnvelope(...args));
}

export function readStablePdfAttachmentRemoval(...args) {
  return attachmentBoundary(() => readStablePdfJavaScriptRemoval(...args));
}

export function writePrivatePdfAttachmentRemovalOutput(...args) {
  return attachmentBoundary(() => writePrivatePdfJavaScriptRemovalOutput(...args));
}

export function pdfAttachmentRemovalContentMatches(source, output) {
  return pdfJavaScriptRemovalContentMatches(source, output);
}

export function sourceSupported(envelope, signatures) {
  const attachment = envelope.attachments?.[0];
  return Number.isSafeInteger(envelope.inspection.pageCount)
    && envelope.inspection.pageCount >= 1 && envelope.inspection.pageCount <= 100
    && String(envelope.inspection.encrypted).toLowerCase() === 'no'
    && String(envelope.inspection.form).toLowerCase() === 'none'
    && String(envelope.inspection.javascript).toLowerCase() === 'no'
    && String(envelope.inspection.tagged).toLowerCase() === 'no'
    && envelope.xmp.present === false && envelope.urls.length === 0
    && envelope.attachments.length === 1 && attachment?.number === 1
    && typeof attachment.name === 'string'
    && /^[\x20-\x7e]{1,240}$/.test(attachment.name)
    && signatures.status === 'unsigned' && signatures.signatureCount === 0;
}

export function outputMatches(source, output) {
  return STABLE_INSPECTION_FIELDS.every(
    (field) => source.inspection[field] === output.inspection[field],
  ) && output.attachments.length === 0
    && isDeepStrictEqual(source.xmp, output.xmp)
    && isDeepStrictEqual(source.custom, output.custom)
    && isDeepStrictEqual(source.urls, output.urls);
}

export function assertProof(proof, source, output, request, removal) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof)
    ? Object.keys(proof) : [];
  const valid = keys.length === PROOF_KEYS.length
    && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === request.profile
    && proof.sourceBytes === source.length && proof.outputBytes === output.length
    && proof.sourceSha256 === createHash('sha256').update(source).digest('hex')
    && proof.outputSha256 === createHash('sha256').update(output).digest('hex')
    && proof.nameSha256 === removal.nameSha256
    && proof.contentSha256 === removal.contentSha256
    && proof.contentBytes === removal.contentBytes
    && proof.removedObjectCount === 3
    && [
      'closedClassicRevision', 'priorRevisionsAbsent', 'attachmentSurfacesAbsent',
      'removedReferencesUnresolvable', 'rootPreserved', 'infoPreserved',
    ].every((key) => proof[key] === true)
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
      'Attachment-removal proof did not match the fixed closed-rewrite contract.',
    );
  }
  return proof;
}

export async function extractAttachmentBinding(
  poppler,
  input,
  output,
  workspace,
  signal,
) {
  const result = await poppler.execute('extractAttachment', {
    input, attachment: 1, output,
  }, {
    cwd: workspace, signal, timeoutMs: 30_000,
    maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024,
  });
  if (String(result?.stderr ?? '').trim()) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_POPPLER_WARNING',
      'Poppler reported a warning while extracting the attachment.',
      422,
    );
  }
  const pathStat = await lstat(output, { bigint: true });
  if (!pathStat.isFile() || pathStat.nlink !== 1n || pathStat.size < 1n
    || pathStat.size > 8n * 1024n * 1024n) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_ATTACHMENT_INVALID',
      'Extracted attachment is not a bounded private regular file.',
      422,
    );
  }
  const handle = await open(
    output,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    let stat = await handle.stat({ bigint: true });
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
      || stat.size !== pathStat.size || stat.nlink !== 1n) {
      fail(
        'PDF_ATTACHMENT_REMOVAL_ATTACHMENT_INVALID',
        'Extracted attachment changed before it could be bound.',
        422,
      );
    }
    await handle.chmod(0o600);
    bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    stat = await handle.stat({ bigint: true });
    if (offset !== bytes.length || stat.dev !== pathStat.dev
      || stat.ino !== pathStat.ino || stat.size !== pathStat.size
      || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) {
      fail(
        'PDF_ATTACHMENT_REMOVAL_ATTACHMENT_INVALID',
        'Extracted attachment changed while it was being bound.',
        422,
      );
    }
    return Object.freeze({
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      contentBytes: bytes.length,
    });
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

export function inventory(stdout) {
  const output = String(stdout ?? '');
  if (Buffer.byteLength(output, 'utf8') > 512 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_POPPLER_OUTPUT_INVALID',
      'Poppler returned an invalid attachment inventory.',
    );
  }
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const header = lines[0]?.match(/^(\d+) embedded files$/);
  const count = header ? Number(header[1]) : -1;
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000
    || lines.length !== count + 1) {
    fail(
      'PDF_ATTACHMENT_REMOVAL_POPPLER_OUTPUT_INVALID',
      'Poppler returned an invalid attachment inventory.',
    );
  }
  const attachments = [];
  for (let index = 1; index <= count; index += 1) {
    const match = lines[index].match(/^(\d+): (.{1,1024})$/);
    if (!match || Number(match[1]) !== index) {
      fail(
        'PDF_ATTACHMENT_REMOVAL_POPPLER_OUTPUT_INVALID',
        'Poppler returned an invalid attachment inventory.',
      );
    }
    attachments.push(Object.freeze({ number: index, name: match[2] }));
  }
  return Object.freeze(attachments);
}
