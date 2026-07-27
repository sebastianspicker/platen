import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { digestFile } from './document-store.mjs';
import {
  createDeadline,
  executeOfflineSignatureInspection,
  PNG_SIGNATURE,
  readRegularOutput,
} from './pdf-service-foundation.mjs';
import {
  assertIncrementalMetadataFileIdentity,
  assertIncrementalMetadataWorkspace,
  incrementalMetadataEnvelopeSupported,
  incrementalMetadataFileIdentity,
  incrementalMetadataRunOptions,
  inspectIncrementalMetadataContent,
  inspectIncrementalMetadataEnvelope,
  readStableIncrementalMetadataOutput,
  readStableIncrementalMetadataSource,
  writePrivateIncrementalMetadataOutput,
} from './pdf-incremental-metadata-validation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { normalizePageTextRequest, PDF_PAGE_TEXT_PROFILE } from './pdf-page-text-contract.mjs';
import { writeIncrementalPdfPageText } from './pdf-page-vector-writer.mjs';
import { runPageTextInsert } from './pdf-page-text-job.mjs';

const MAX_JOB_MS = 2 * 60_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (1024 * 1024);
const SHA256 = /^[0-9a-f]{64}$/u;
const BEFORE_FILES = Object.freeze(['input.pdf']);
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const PROOF_KEYS = Object.freeze([
  'profile', 'page', 'x', 'y', 'size', 'textSha256', 'sourceSha256',
  'outputSha256', 'sourcePrefixPreserved', 'textStreamObjectNumber',
  'fontObjectNumber', 'resourceName', 'baseFont',
]);
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
const DEFAULT_CORE = Object.freeze({ normalizePageTextRequest, writeIncrementalPdfPageText });
const PRESERVED_INFO_FIELDS = Object.freeze([
  'title', 'author', 'subject', 'keywords', 'creator', 'producer', 'createdAt',
  'modifiedAt', 'pageSize', 'pageRotation', 'pdfVersion',
]);

export const PDF_PAGE_TEXT_LIMITATIONS = Object.freeze([
  'Only strict unsigned, unencrypted, passive classic PDFs with a content-empty target page are accepted.',
  'Text is limited to 512 bytes of canonical printable ASCII and is written with the fixed built-in Helvetica font.',
  'Historical source bytes remain present in the append-only revision; this is not redaction, sanitization, conformance validation, or byte preservation.',
]);

export const PDF_PAGE_TEXT_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-writer-proof',
  'source-prefix-preserved', 'pdfsig-source-output-unsigned',
  'poppler-passive-envelope', 'poppler-page-count', 'poppler-page-boxes',
  'poppler-target-page-text', 'poppler-render-target-diff-other-pages-match',
  'source-unchanged', 'artifact-sha256',
]);

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function checkedCore(core) {
  if (!core || typeof core.normalizePageTextRequest !== 'function'
    || typeof core.writeIncrementalPdfPageText !== 'function') {
    throw new TypeError('PdfPageTextService requires the fixed page-text core API.');
  }
  return core;
}

function checkedRequest(core, value) {
  try { return core.normalizePageTextRequest(value); }
  catch (error) {
    if (error?.code === 'INVALID_PAGE_TEXT') {
      fail('INVALID_PAGE_TEXT_OPTIONS', 'The requested page-text insertion is invalid.', 400, error);
    }
    throw error;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('Page-text insertion was cancelled.');
}

function buffersOverlap(left, right) {
  return left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}

export function assertPageTextWriterProof(proof, request, sourceSha256, outputSha256) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof)
    ? Object.keys(proof) : [];
  const objectNumber = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 999_999;
  const valid = keys.length === PROOF_KEYS.length
    && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === PDF_PAGE_TEXT_PROFILE && proof.page === request.page
    && proof.x === request.x && proof.y === request.y && proof.size === request.size
    && proof.textSha256 === createHash('sha256').update(request.text, 'utf8').digest('hex')
    && proof.sourceSha256 === sourceSha256 && proof.outputSha256 === outputSha256
    && SHA256.test(proof.sourceSha256) && SHA256.test(proof.outputSha256)
    && proof.sourceSha256 !== proof.outputSha256
    && proof.sourcePrefixPreserved === true
    && objectNumber(proof.textStreamObjectNumber) && objectNumber(proof.fontObjectNumber)
    && proof.textStreamObjectNumber !== proof.fontObjectNumber
    && proof.resourceName === 'F1' && proof.baseFont === 'Helvetica';
  if (!valid) fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The raw page-text writer proof did not match the fixed contract.');
  return proof;
}

function passiveInspection(inspection) {
  const layers = inspection?.raw?.layers ?? inspection?.raw?.optionalContent;
  return String(inspection?.tagged).toLowerCase() === 'no'
    && String(inspection?.suspects).toLowerCase() !== 'yes'
    && (layers === undefined || ['no', 'none', '0'].includes(String(layers).toLowerCase()));
}

async function snapshot({ poppler, input, workspace, signatureWorkspace, signal }) {
  const settled = await Promise.allSettled([
    inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal }),
  ]);
  const rejected = settled.find(({ status }) => status === 'rejected');
  if (rejected) throw rejected.reason;
  const [envelope, signatures] = settled.map(({ value }) => value);
  if (!incrementalMetadataEnvelopeSupported(envelope, signatures)
    || !passiveInspection(envelope.inspection)) {
    fail('PDF_PAGE_TEXT_SOURCE_UNSUPPORTED', 'Page-text insertion requires an unsigned, unencrypted, untagged PDF without forms, JavaScript, metadata streams, attachments, URLs, or layers.', 422);
  }
  const content = await inspectIncrementalMetadataContent(
    poppler, input, workspace, signal, envelope.inspection.pageCount,
  );
  return Object.freeze({ envelope, signatures, content });
}

function passiveEnvelopeMatches(source, output) {
  return source.inspection.pageCount === output.inspection.pageCount
    && PRESERVED_INFO_FIELDS.every((field) => source.inspection[field] === output.inspection[field])
    && isDeepStrictEqual(source.xmp, output.xmp)
    && isDeepStrictEqual(source.custom, output.custom)
    && isDeepStrictEqual(source.attachments, output.attachments)
    && isDeepStrictEqual(source.urls, output.urls);
}

function textOutputMatches(source, output, request) {
  if (!isDeepStrictEqual(source.pageBoxes, output.pageBoxes)
    || source.textPages.length !== output.textPages.length) return false;
  for (let index = 0; index < source.textPages.length; index += 1) {
    if (index === request.page - 1) {
      if (source.textPages[index]?.text !== ''
        || output.textPages[index]?.text.trim() !== request.text) return false;
    } else if (!isDeepStrictEqual(source.textPages[index], output.textPages[index])) return false;
  }
  return true;
}

async function renderPage(poppler, input, prefix, workspace, signal, page) {
  const result = await poppler.execute('renderPagePng', {
    input, outputPrefix: prefix, page, maxDimension: 256,
  }, incrementalMetadataRunOptions(workspace, signal, 64 * 1024));
  if (String(result?.stderr ?? '').trim()) {
    fail('PDF_PAGE_TEXT_POPPLER_WARNING', 'Poppler reported a warning while validating page-text insertion.', 422);
  }
  const bytes = await readRegularOutput(`${prefix}.png`, {
    minimumBytes: PNG_SIGNATURE.length,
    maximumBytes: 32 * 1024 * 1024,
    label: 'Page-text validation render',
  });
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail('PDF_PAGE_TEXT_OUTPUT_INVALID', 'Poppler produced an invalid page-text validation render.');
  }
  return bytes;
}

async function assertRenders({ poppler, sourcePath, outputPath, workspace, signal, pageCount, targetPage }) {
  for (let page = 1; page <= pageCount; page += 1) {
    throwIfAborted(signal);
    const sourcePrefix = join(workspace, `source-text-render-${page}`);
    const outputPrefix = join(workspace, `output-text-render-${page}`);
    try {
      const [sourceRender, outputRender] = await Promise.all([
        renderPage(poppler, sourcePath, sourcePrefix, workspace, signal, page),
        renderPage(poppler, outputPath, outputPrefix, workspace, signal, page),
      ]);
      const equal = sourceRender.equals(outputRender);
      if (page === targetPage ? equal : !equal) {
        fail('PDF_PAGE_TEXT_OUTPUT_INVALID', page === targetPage
          ? `Page-text insertion did not change the validation render of target page ${page}.`
          : `Page-text insertion changed the validation render of non-target page ${page}.`);
      }
    } finally {
      await Promise.allSettled([
        unlink(`${sourcePrefix}.png`), unlink(`${outputPrefix}.png`),
      ]);
    }
  }
}

function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) return new HostError('PDF_PAGE_TEXT_TIMEOUT', 'Page-text insertion exceeded its two-minute deadline.', 504, { cause: error });
  if (externalSignal?.aborted) return new HostError('JOB_CANCELLED', 'Page-text insertion was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'INVALID_PAGE_TEXT') return new HostError('INVALID_PAGE_TEXT_OPTIONS', 'The requested page-text insertion is invalid.', 400, { cause: error });
  if (error?.code === 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF') return new HostError('PDF_PAGE_TEXT_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded append-only page-text subset.', 422, { cause: error });
  if (error?.code === 'INVALID_INCREMENTAL_PAGE_VECTOR_OUTPUT') return new HostError('PDF_PAGE_TEXT_OUTPUT_INVALID', 'The append-only page-text output failed raw validation.', 502, { cause: error });
  return new HostError('PDF_PAGE_TEXT_FAILED', 'The local host could not create a verified append-only page-text copy.', 502, { cause: error });
}

async function cleanupAfterJob({ store, workspaces, promotedArtifact, completed }) {
  const results = await Promise.allSettled(workspaces.map(
    (workspace) => Promise.resolve().then(() => store.cleanupJob(workspace)),
  ));
  const workspaceFailed = results.some(({ status }) => status === 'rejected');
  let artifactFailed = false;
  if ((!completed || workspaceFailed) && promotedArtifact?.id) {
    try { await store.deleteArtifact(promotedArtifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) {
    fail('PDF_PAGE_TEXT_CLEANUP_FAILED', 'Page-text insertion could not clean its private workspace or derived artifact.', 500);
  }
}

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeResult);
  return Object.freeze(value);
}

export class PdfPageTextService {
  #store;
  #poppler;
  #core;

  constructor({ store, poppler, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('PdfPageTextService requires a DocumentStore-compatible store.');
    }
    if (!poppler || typeof poppler.execute !== 'function') {
      throw new TypeError('PdfPageTextService requires a Poppler adapter.');
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#core = checkedCore(core);
  }

  async insert(documentId, input = {}) {
    return runPageTextInsert({
      deps: {
        SHA256, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES, MAX_JOB_MS, BEFORE_FILES, AFTER_FILES,
        PDF_PAGE_TEXT_VALIDATORS, PDF_PAGE_TEXT_LIMITATIONS,
        checkedRequest, fail, createDeadline, throwIfAborted, buffersOverlap,
        assertPageTextWriterProof, stagePrivateSourceCopy,
        assertWorkspace: assertIncrementalMetadataWorkspace,
        snapshot, readSource: readStableIncrementalMetadataSource,
        writeOutput: writePrivateIncrementalMetadataOutput,
        fileIdentity: incrementalMetadataFileIdentity,
        readOutput: readStableIncrementalMetadataOutput,
        assertFileIdentity: assertIncrementalMetadataFileIdentity,
        passiveEnvelopeMatches, textOutputMatches, assertRenders,
        assertPrivateSourceCopy, digestFile, createOperationProvenance,
        mapFailure, cleanupAfterJob, freezeResult,
      },
      store: this.#store, poppler: this.#poppler, core: this.#core, documentId, input,
    });
  }
}

export function createPdfPageTextService(options) {
  return new PdfPageTextService(options);
}

// Text insertion and literal replacement share the local page-text surface but
// remain separate contracts and services. This narrow re-export keeps the
// replacement lane production-reachable without adding a competing route.
export {
  PdfTextEditService,
  createPdfTextEditService,
  createPdfFindReplaceService,
  PDF_TEXT_EDIT_LIMITATIONS,
} from './pdf-text-edit-service.mjs';
