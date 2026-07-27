import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPdfkitRequestPath, PDFKIT_MAX_REQUEST_BYTES } from './adapters/pdfkit.mjs';
import { digestFile } from './document-store.mjs';
import { fail, hash } from './aec-artifact-validation.mjs';

export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MAX_PAGES = 100;
export const MAX_ANNOTATIONS_PER_PAGE = 50;
export const TIMEOUT_MS = 30_000;
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf', 'request.json']);

export function createJobSignal(externalSignal) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('AEC job deadline exceeded.'));
  }, 2 * 60_000);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    },
  });
}

export async function writePrivateRequest(path, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length < 1 || bytes.length > PDFKIT_MAX_REQUEST_BYTES) {
    fail('AEC_NATIVE_REQUEST_TOO_LARGE', 'AEC native request exceeds the fixed helper limit.', 413);
  }
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o400);
  return hash(bytes);
}

export async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

export async function assertIdentity(path, expected) {
  const actual = await fileIdentity(path);
  if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
    fail('AEC_NATIVE_WORKSPACE_INVALID', 'An AEC native workspace file changed during validation.', 502);
  }
}

export async function assertWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  const names = [...expected].sort();
  if (entries.length !== names.length
    || entries.some((entry, index) => entry !== names[index])) {
    fail('AEC_NATIVE_WORKSPACE_INVALID', 'The AEC native helper changed its private workspace topology.', 502);
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      fail('AEC_NATIVE_WORKSPACE_INVALID', 'The AEC native workspace contains an unsafe file.', 502);
    }
  }
}

export async function assertOutput(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || metadata.size < 5 || metadata.size > MAX_OUTPUT_BYTES) {
    fail('AEC_NATIVE_OUTPUT_INVALID', 'The AEC native helper did not produce a bounded private PDF.', 502);
  }
}

function helperRequest(document, measurement, calibration) {
  return {
    version: 1,
    operation: 'applyAecMeasurement',
    inputFilename: 'input.pdf',
    outputFilename: 'output.pdf',
    sourceSha256: document.sha256,
    limits: {
      maxPages: MAX_PAGES,
      maxAnnotationsPerPage: MAX_ANNOTATIONS_PER_PAGE,
      maxWidgetsPerPage: 0,
      maxOutlineDepth: 0,
      maxOutlineItems: 0,
    },
    measurement: {
      id: measurement.id,
      page: measurement.source.page,
      kind: measurement.kind,
      points: measurement.geometry.points,
      quantity: measurement.result.siValue,
      unit: measurement.result.siUnit,
      calibrationId: measurement.calibrationId,
      label: measurement.label,
      calibration: calibration ? {
        points: calibration.segment,
        realLength: calibration.knownLength.value,
        sourceUnit: calibration.knownLength.unit,
        metersPerPoint: calibration.metersPerPdfPoint,
      } : null,
    },
  };
}

export async function preparePrivateExport({
  store,
  documentId,
  document,
  workspace,
  measurement,
  calibration,
}) {
  const sourcePath = store.getSourcePath(documentId);
  const inputPath = join(workspace, 'input.pdf');
  const outputPath = join(workspace, 'output.pdf');
  const requestPath = createPdfkitRequestPath(workspace);
  await copyFile(sourcePath, inputPath, fsConstants.COPYFILE_EXCL);
  await chmod(inputPath, 0o400);
  if (await digestFile(inputPath) !== document.sha256) {
    fail('SOURCE_INTEGRITY_FAILED', 'Private AEC source copy does not match the immutable PDF.', 500);
  }
  const requestDigest = await writePrivateRequest(
    requestPath,
    helperRequest(document, measurement, calibration),
  );
  return {
    sourcePath,
    inputPath,
    outputPath,
    requestPath,
    requestDigest,
    inputIdentity: await fileIdentity(inputPath),
    requestIdentity: await fileIdentity(requestPath),
  };
}

function receiptMatches({ receipt, document, outputSha256, measurement, pageCount }) {
  return receipt.sourceSha256 === document.sha256
    && receipt.outputSha256 === outputSha256
    && receipt.measurementId === measurement.id
    && receipt.page === measurement.source.page
    && receipt.kind === measurement.kind
    && receipt.quantity === measurement.result.siValue
    && receipt.unit === measurement.result.siUnit
    && receipt.calibrationId === measurement.calibrationId
    && receipt.measurementDictionaryEmbedded === false
    && receipt.pageCount === pageCount
    && receipt.annotationCount >= 1
    && receipt.annotationCount <= MAX_ANNOTATIONS_PER_PAGE;
}

export async function validateHelperExport({
  workspace,
  inputPath,
  outputPath,
  requestPath,
  inputIdentity,
  requestIdentity,
  requestDigest,
  document,
  receipt,
  measurement,
  pageCount,
}) {
  await assertWorkspace(workspace, AFTER_FILES);
  await assertOutput(outputPath);
  await assertIdentity(inputPath, inputIdentity);
  await assertIdentity(requestPath, requestIdentity);
  if (await digestFile(inputPath) !== document.sha256
    || await digestFile(requestPath) !== requestDigest) {
    fail('AEC_NATIVE_WORKSPACE_INVALID', 'AEC helper changed its immutable inputs.', 502);
  }
  const outputSha256 = await digestFile(outputPath);
  if (!receiptMatches({ receipt, document, outputSha256, measurement, pageCount })) {
    fail('AEC_NATIVE_RECEIPT_INVALID', 'AEC helper receipt does not match the requested source-bound measurement.', 502);
  }
  return outputSha256;
}
