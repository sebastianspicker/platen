import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import {
  parseAttachments,
  parseCustomMetadata,
  parseDocumentUrls,
  parsePageBoxes,
  parsePdfInfo,
  parseTextPages,
  parseXmpMetadata,
  PNG_SIGNATURE,
  readRegularOutput,
} from './pdf-service-foundation.mjs';

export const MAX_INCREMENTAL_METADATA_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_INCREMENTAL_METADATA_OUTPUT_BYTES = MAX_INCREMENTAL_METADATA_SOURCE_BYTES + (1024 * 1024);
export const MAX_INCREMENTAL_METADATA_PAGES = 100;
export const INCREMENTAL_METADATA_BEFORE_FILES = Object.freeze(['input.pdf']);
export const INCREMENTAL_METADATA_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);

const MAX_RENDER_BYTES = 32 * 1024 * 1024;
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
const METADATA_FIELDS = Object.freeze(['title', 'author', 'subject', 'keywords']);
const PRESERVED_INFO_FIELDS = Object.freeze(['creator', 'producer', 'createdAt', 'modifiedAt']);
const TARGET_INFO_NAMES = new Set(['Title', 'Author', 'Subject', 'Keywords']);
const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved',
  'priorObjectOffsetsPreserved', 'revisionCount', 'previousXrefOffset', 'appendedXrefOffset',
  'infoObjectNumber', 'infoGeneration', 'effectiveSize', 'rootPreserved', 'idPolicy',
  'metadataFieldCount',
]);

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

function requireSilentPoppler(results) {
  if (results.some((result) => String(result?.stderr ?? '').trim().length > 0)) {
    fail('INCREMENTAL_METADATA_POPPLER_WARNING', 'Poppler reported a warning while validating the incremental metadata PDF.', 422);
  }
}

async function settledValues(promises) {
  const results = await Promise.allSettled(promises);
  const rejected = results.find(({ status }) => status === 'rejected');
  if (rejected) throw rejected.reason;
  return results.map(({ value }) => value);
}

export function incrementalMetadataRunOptions(workspace, signal, maxStdoutBytes = 4 * 1024 * 1024) {
  return { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes, maxStderrBytes: 256 * 1024 };
}

export async function inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal) {
  const options = incrementalMetadataRunOptions(workspace, signal);
  const [infoResult, xmpResult, customResult, attachmentsResult, urlsResult] = await settledValues([
    poppler.execute('inspect', { input }, options),
    poppler.execute('inspectMetadata', { input }, options),
    poppler.execute('inspectCustomMetadata', { input }, options),
    poppler.execute('listAttachments', { input }, options),
    poppler.execute('inspectUrls', { input }, options),
  ]);
  requireSilentPoppler([infoResult, xmpResult, customResult, attachmentsResult, urlsResult]);
  return Object.freeze({
    inspection: parsePdfInfo(infoResult.stdout),
    xmp: parseXmpMetadata(xmpResult.stdout),
    custom: parseCustomMetadata(customResult.stdout),
    attachments: parseAttachments(attachmentsResult.stdout),
    urls: parseDocumentUrls(urlsResult.stdout),
  });
}

export async function inspectIncrementalMetadataContent(poppler, input, workspace, signal, pageCount) {
  const options = incrementalMetadataRunOptions(workspace, signal, 32 * 1024 * 1024);
  const [boxesResult, textResult] = await settledValues([
    poppler.execute('inspectPageBoxes', { input, firstPage: 1, lastPage: pageCount }, options),
    poppler.execute('extractText', { input, layout: true }, options),
  ]);
  requireSilentPoppler([boxesResult, textResult]);
  return Object.freeze({
    pageBoxes: parsePageBoxes(boxesResult.stdout, { firstPage: 1, lastPage: pageCount }),
    textPages: parseTextPages(textResult.stdout, pageCount),
  });
}

export function incrementalMetadataEnvelopeSupported(envelope, signatures) {
  const { inspection } = envelope;
  return inspection.pageCount >= 1 && inspection.pageCount <= MAX_INCREMENTAL_METADATA_PAGES
    && String(inspection.encrypted).toLowerCase() === 'no'
    && String(inspection.form).toLowerCase() === 'none'
    && String(inspection.javascript).toLowerCase() === 'no'
    && envelope.attachments.length === 0 && envelope.urls.length === 0
    && envelope.xmp.present === false
    && signatures.status === 'unsigned' && signatures.signatureCount === 0;
}

export function incrementalMetadataOutputMatches(source, output, metadata) {
  const sourceCustom = source.custom.filter(({ name }) => !TARGET_INFO_NAMES.has(name));
  const outputCustom = output.custom.filter(({ name }) => !TARGET_INFO_NAMES.has(name));
  return output.inspection.pageCount === source.inspection.pageCount
    && METADATA_FIELDS.every((field) => output.inspection[field] === metadata[field])
    && PRESERVED_INFO_FIELDS.every((field) => output.inspection[field] === source.inspection[field])
    && isDeepStrictEqual(sourceCustom, outputCustom);
}

export function incrementalMetadataContentMatches(source, output) {
  return isDeepStrictEqual(source.pageBoxes, output.pageBoxes)
    && isDeepStrictEqual(source.textPages, output.textPages);
}

export async function assertIncrementalMetadataWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) {
    fail('INCREMENTAL_METADATA_WORKSPACE_INVALID', 'Incremental metadata processing changed its private workspace topology.');
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || (metadata.mode & 0o077) !== 0) {
      fail('INCREMENTAL_METADATA_WORKSPACE_INVALID', 'Incremental metadata processing produced an unsafe workspace file.');
    }
  }
}

export async function writePrivateIncrementalMetadataOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_INCREMENTAL_METADATA_OUTPUT_BYTES) {
    fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The incremental writer did not return a bounded PDF buffer.');
  }
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(path, 0o400);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(path).catch(() => {});
    if (error instanceof HostError) throw error;
    fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The incremental output could not be staged privately.');
  }
}

export async function readStableIncrementalMetadataOutput(path) {
  return readRegularOutput(path, {
    minimumBytes: 64,
    maximumBytes: MAX_INCREMENTAL_METADATA_OUTPUT_BYTES,
    label: 'Incremental metadata PDF output',
  });
}

export async function readStableIncrementalMetadataSource(path, expectedSize) {
  const bytes = await readRegularOutput(path, {
    minimumBytes: 5,
    maximumBytes: MAX_INCREMENTAL_METADATA_SOURCE_BYTES,
    label: 'Private incremental metadata source',
  });
  if (bytes.length !== expectedSize) {
    fail('SOURCE_INTEGRITY_FAILED', 'The private incremental metadata source changed before parsing.', 500);
  }
  return bytes;
}

export function assertIncrementalMetadataProof(proof, sourceLength, outputLength) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const exactKeys = keys.length === PROOF_KEYS.length && keys.every((key, index) => key === PROOF_KEYS[index]);
  const valid = exactKeys && proof.profile === 'local-classic-incremental-metadata-v1'
    && proof.sourceBytes === sourceLength && proof.outputBytes === outputLength
    && proof.appendedBytes === outputLength - sourceLength && proof.appendedBytes > 0
    && proof.sourcePrefixPreserved === true && proof.priorObjectOffsetsPreserved === true
    && Number.isSafeInteger(proof.revisionCount) && proof.revisionCount >= 2
    && Number.isSafeInteger(proof.previousXrefOffset) && proof.previousXrefOffset > 0
    && proof.previousXrefOffset < sourceLength
    && Number.isSafeInteger(proof.appendedXrefOffset) && proof.appendedXrefOffset >= sourceLength
    && proof.appendedXrefOffset < outputLength
    && Number.isSafeInteger(proof.infoObjectNumber) && proof.infoObjectNumber > 0
    && proof.infoGeneration === 0 && proof.effectiveSize === proof.infoObjectNumber + 1
    && proof.rootPreserved === true
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy)
    && proof.metadataFieldCount === METADATA_FIELDS.length;
  if (!valid) {
    fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The raw incremental metadata proof did not match the fixed append-only contract.');
  }
  return proof;
}

export async function incrementalMetadataFileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, metadata[key]])));
}

export async function assertIncrementalMetadataFileIdentity(path, expected) {
  const actual = await incrementalMetadataFileIdentity(path);
  if (IDENTITY_KEYS.some((key) => actual[key] !== expected[key])) {
    fail('INCREMENTAL_METADATA_WORKSPACE_INVALID', 'An incremental metadata workspace file changed during validation.');
  }
}

async function renderPage(poppler, input, outputPrefix, workspace, signal, page) {
  const result = await poppler.execute('renderPagePng', { input, outputPrefix, page, maxDimension: 256 },
    incrementalMetadataRunOptions(workspace, signal, 64 * 1024));
  requireSilentPoppler([result]);
  const path = `${outputPrefix}.png`;
  const bytes = await readRegularOutput(path, { minimumBytes: PNG_SIGNATURE.length, maximumBytes: MAX_RENDER_BYTES, label: 'Incremental metadata validation render' });
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'Poppler produced an invalid incremental metadata validation render.');
  }
  return bytes;
}

export async function assertIncrementalMetadataRendersMatch({ poppler, sourcePath, outputPath, workspace, signal, pageCount }) {
  for (let page = 1; page <= pageCount; page += 1) {
    const sourcePrefix = join(workspace, `source-render-${page}`);
    const outputPrefix = join(workspace, `output-render-${page}`);
    try {
      const sourceRender = await renderPage(poppler, sourcePath, sourcePrefix, workspace, signal, page);
      const outputRender = await renderPage(poppler, outputPath, outputPrefix, workspace, signal, page);
      if (!sourceRender.equals(outputRender)) {
        fail('INCREMENTAL_METADATA_OUTPUT_INVALID', `Incremental metadata changed the Poppler render of page ${page}.`);
      }
    } finally {
      await Promise.allSettled([
        unlink(`${sourcePrefix}.png`),
        unlink(`${outputPrefix}.png`),
      ]);
    }
  }
}
