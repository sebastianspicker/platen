import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRegularOutput } from './bounded-output-io.mjs';
import { runConversionJob } from './conversion-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import {
  parsePageDimensions,
  parsePdfInfo,
  parseTextPages,
} from './pdf-service-foundation.mjs';
import {
  assertPrivateSourceCopy,
  stagePrivateSourceCopy,
} from './private-source-copy.mjs';

function invalid(profile, message, status = 422) {
  throw new HostError(profile.invalidCode, message, status);
}

function assertNotAborted(signal, profile) {
  if (!signal.aborted) return;
  const error = new Error(`${profile.label}-to-PDF export validation was cancelled.`);
  error.code = 'ENGINE_CANCELLED';
  throw error;
}

function runOptions(profile, workspace, signal, timeoutMs, maxStdoutBytes, bytes) {
  return {
    cwd: workspace,
    signal,
    stdin: bytes,
    maxStdinBytes: profile.maxBytes,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes: 128 * 1024,
  };
}

function hasExactParameters(parameters, profile) {
  if (!parameters || Object.keys(parameters).length !== 3) return false;
  return [
    parameters.sourceFormat === profile.sourceFormat,
    parameters.sourceKind === profile.sourceKind,
    parameters.conversionMode === 'libreoffice',
  ].every(Boolean);
}

function hasExactValidation(validation) {
  const validators = validation?.validators;
  return [
    validation?.passed === true,
    Array.isArray(validators),
    validators?.length === 3,
    validators?.[0] === 'source-sha256',
    validators?.[1] === 'libreoffice-exit-zero',
    validators?.[2] === 'pdfinfo-page-count',
  ].every(Boolean);
}

function assertProvenance(source, profile) {
  const operation = source.operation;
  const valid = [
    source.origin === 'derived',
    operation?.type === profile.operationType,
    hasExactParameters(operation?.parameters, profile),
    hasExactValidation(operation?.validation),
  ].every(Boolean);
  if (!valid) {
    invalid(profile, profile.provenanceMessage, 403);
  }
}

async function stageSource(documents, documentId, source, input, signal, profile) {
  try {
    return await stagePrivateSourceCopy({
      sourcePath: documents.getSourcePath(documentId),
      targetPath: input,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: profile.maxBytes,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HostError('SOURCE_INTEGRITY_FAILED', profile.bindingMessage, 500, { cause: error });
  }
}

async function assertStaged(input, identity, source, signal, profile) {
  assertNotAborted(signal, profile);
  try {
    await assertPrivateSourceCopy({
      path: input,
      identity,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: profile.maxBytes,
    });
  } catch (error) {
    throw new HostError('SOURCE_INTEGRITY_FAILED', profile.driftMessage, 500, { cause: error });
  }
}

function assertPassivePdf(inspection, profile) {
  if (inspection.encrypted !== 'no'
    || inspection.javascript !== 'no'
    || inspection.form !== 'none') invalid(profile, profile.passiveMessage);
}

function assertTextCoverage(textPages, pageCount, profile) {
  if (textPages.length !== pageCount
    || textPages.some((page, index) => page.page !== index + 1)) {
    invalid(profile, profile.textCoverageMessage);
  }
  const textBytes = textPages.reduce((total, page) => total + Buffer.byteLength(page.text, 'utf8'), 0);
  if (textBytes > profile.maxTextBytes) {
    throw new HostError(profile.textLimitCode, profile.textLimitMessage, 422);
  }
}

export async function prepareLibreOfficeDerivedPdfExport({
  documents,
  poppler,
  documentId,
  externalSignal,
  profile,
}) {
  const source = documents.getDocument(documentId);
  if (source.size < 64 || source.size > profile.maxBytes) {
    throw new HostError(profile.invalidCode, profile.sizeMessage, 502);
  }
  assertProvenance(source, profile);
  return runConversionJob({
    owner: documents,
    resourceId: documentId,
    externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      const input = join(workspace, profile.snapshotName);
      await documents.verifySource(documentId);
      const identity = await stageSource(documents, documentId, source, input, signal, profile);
      await checkQuota();
      const bytes = await readRegularOutput(input, {
        minimumBytes: 64,
        maximumBytes: profile.maxBytes,
        label: profile.snapshotLabel,
      });
      if (bytes.length !== source.size
        || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', profile.byteMismatchMessage, 500);
      }
      await assertStaged(input, identity, source, signal, profile);
      const inspection = parsePdfInfo((await poppler.execute(
        'inspectStdin', {}, runOptions(profile, workspace, signal, 20_000, 512 * 1024, bytes),
      )).stdout);
      if (inspection.pageCount > profile.maxPages) {
        throw new HostError(profile.pageLimitCode, profile.pageLimitMessage, 422);
      }
      assertPassivePdf(inspection, profile);
      const pages = [];
      for (let page = 1; page <= inspection.pageCount; page += 1) {
        pages.push(parsePageDimensions((await poppler.execute(
          'inspectPageStdin', { page },
          runOptions(profile, workspace, signal, 20_000, 512 * 1024, bytes),
        )).stdout, page));
      }
      const textPages = parseTextPages((await poppler.execute(
        'extractTextStdin', { layout: true },
        runOptions(profile, workspace, signal, 30_000, profile.maxTextBytes, bytes),
      )).stdout, inspection.pageCount);
      assertTextCoverage(textPages, inspection.pageCount, profile);
      assertNotAborted(signal, profile);
      await checkQuota();
      await assertStaged(input, identity, source, signal, profile);
      await documents.verifySource(documentId);
      assertNotAborted(signal, profile);
      return Object.freeze({
        bytes,
        inspection,
        pages: Object.freeze(pages),
        textPages,
      });
    },
  });
}
