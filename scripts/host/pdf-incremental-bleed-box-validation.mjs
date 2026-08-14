import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { PNG_SIGNATURE, readRegularOutput } from './pdf-service-foundation.mjs';
import {
  incrementalMetadataEnvelopeSupported, incrementalMetadataFileIdentity,
  assertIncrementalMetadataFileIdentity, inspectIncrementalMetadataEnvelope,
  inspectIncrementalMetadataContent, incrementalMetadataRunOptions,
} from './pdf-incremental-metadata-validation.mjs';

export const MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_INCREMENTAL_BLEED_BOX_OUTPUT_BYTES = MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES
  + 1024 * 1024;
export const INCREMENTAL_BLEED_BOX_BEFORE_FILES = Object.freeze(['input.pdf']);
export const INCREMENTAL_BLEED_BOX_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved',
  'onlyTargetChanged', 'revisionCount', 'sourceRevisionCount', 'previousXrefOffset',
  'appendedXrefOffset', 'page', 'pageObjectNumber', 'pageGeneration',
  'pageReference', 'rect', 'effectiveSize', 'rootPreserved', 'infoPreserved',
  'idPolicy',
]);
const STABLE_INFO_FIELDS = Object.freeze([
  'pageCount', 'title', 'author', 'subject', 'keywords', 'creator', 'producer',
  'createdAt', 'modifiedAt', 'tagged', 'userProperties', 'suspects', 'form',
  'javascript', 'encrypted', 'pageSize', 'pageRotation', 'optimized', 'pdfVersion',
]);

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

export {
  incrementalMetadataEnvelopeSupported as incrementalBleedBoxEnvelopeSupported,
  inspectIncrementalMetadataEnvelope as inspectIncrementalBleedBoxEnvelope,
};

export async function inspectIncrementalBleedBoxContent(
  poppler,
  input,
  workspace,
  signal,
  pageCount,
) {
  return inspectIncrementalMetadataContent(poppler, input, workspace, signal, pageCount);
}

export function incrementalBleedBoxEnvelopeMatches(source, output) {
  return STABLE_INFO_FIELDS.every(
    (field) => source.inspection[field] === output.inspection[field],
  )
    && isDeepStrictEqual(source.custom, output.custom)
    && isDeepStrictEqual(source.attachments, output.attachments)
    && isDeepStrictEqual(source.urls, output.urls)
    && isDeepStrictEqual(source.xmp, output.xmp);
}

export async function assertIncrementalBleedBoxWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) {
    fail(
      'INCREMENTAL_BLEED_BOX_WORKSPACE_INVALID',
      'Incremental bleed-box processing changed its private workspace topology.',
    );
  }
  for (const entry of entries) {
    const stat = await lstat(join(workspace, entry));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0) {
      fail(
        'INCREMENTAL_BLEED_BOX_WORKSPACE_INVALID',
        'Incremental bleed-box processing produced an unsafe workspace file.',
      );
    }
  }
}

export async function writePrivateIncrementalBleedBoxOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64
    || bytes.length > MAX_INCREMENTAL_BLEED_BOX_OUTPUT_BYTES) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'The incremental writer did not return a bounded PDF buffer.',
    );
  }
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(path, 0o400);
  } catch {
    await handle?.close().catch(() => {});
    await unlink(path).catch(() => {});
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'The incremental bleed-box output could not be staged privately.',
    );
  }
}

export async function readStableIncrementalBleedBox(
  path,
  maximumBytes = MAX_INCREMENTAL_BLEED_BOX_OUTPUT_BYTES,
) {
  return readRegularOutput(path, {
    minimumBytes: 64,
    maximumBytes,
    label: 'Incremental bleed-box PDF',
  });
}
export function assertIncrementalBleedBoxProof(proof, sourceLength, outputLength, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof)
    ? Object.keys(proof) : [];
  const valid = keys.length === PROOF_KEYS.length
    && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === request.profile
    && proof.sourceBytes === sourceLength && proof.outputBytes === outputLength
    && proof.appendedBytes === outputLength - sourceLength
    && proof.appendedBytes > 0 && proof.appendedBytes <= 1024 * 1024
    && proof.sourcePrefixPreserved === true && proof.onlyTargetChanged === true
    && proof.revisionCount === proof.sourceRevisionCount + 1
    && proof.sourceRevisionCount >= 1 && proof.sourceRevisionCount <= 31
    && Number.isSafeInteger(proof.previousXrefOffset) && proof.previousXrefOffset > 0
    && proof.previousXrefOffset < sourceLength
    && Number.isSafeInteger(proof.appendedXrefOffset) && proof.appendedXrefOffset >= sourceLength
    && proof.appendedXrefOffset < outputLength && proof.page === request.page
    && isDeepStrictEqual(proof.rect, request.rect)
    && Number.isSafeInteger(proof.pageObjectNumber) && proof.pageObjectNumber > 0
    && Number.isSafeInteger(proof.pageGeneration) && proof.pageGeneration >= 0
    && proof.pageGeneration <= 65_535
    && proof.pageReference === `${proof.pageObjectNumber} ${proof.pageGeneration} R`
    && Number.isSafeInteger(proof.effectiveSize)
    && proof.effectiveSize > proof.pageObjectNumber && proof.effectiveSize < 1_000_000
    && proof.rootPreserved === true && proof.infoPreserved === true
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) fail('INCREMENTAL_BLEED_BOX_OUTPUT_INVALID', 'The raw incremental bleed-box proof did not match the fixed append-only contract.');
  return proof;
}
export {
  incrementalMetadataFileIdentity as incrementalBleedBoxFileIdentity,
  assertIncrementalMetadataFileIdentity as assertIncrementalBleedBoxFileIdentity,
};

function expectedBleedBox(request) {
  return {
    left: request.rect.x,
    bottom: request.rect.y,
    right: request.rect.x + request.rect.width,
    top: request.rect.y + request.rect.height,
    width: request.rect.width,
    height: request.rect.height,
  };
}

function stablePageGeometryMatches(source, output) {
  return source.page === output.page
    && source.widthPoints === output.widthPoints
    && source.heightPoints === output.heightPoints
    && source.rotation === output.rotation;
}

function selectedNonTargetBoxesMatch(source, output) {
  return ['mediaBox', 'cropBox', 'trimBox', 'artBox'].every(
    (name) => isDeepStrictEqual(source.boxes[name] ?? null, output.boxes[name] ?? null),
  );
}

export function incrementalBleedBoxContentMatches(source, output, request) {
  if (!isDeepStrictEqual(source.textPages, output.textPages)
    || source.pageBoxes.length !== output.pageBoxes.length) return false;
  return source.pageBoxes.every((entry, index) => {
    const other = output.pageBoxes[index];
    if (!stablePageGeometryMatches(entry, other)
      || !selectedNonTargetBoxesMatch(entry, other)) return false;
    if (entry.page !== request.page) return isDeepStrictEqual(entry.boxes, other.boxes);
    return isDeepStrictEqual(other.boxes.bleedBox, expectedBleedBox(request));
  });
}

async function render(poppler, input, prefix, workspace, signal, page) {
  const result = await poppler.execute(
    'renderPagePng',
    { input, outputPrefix: prefix, page, maxDimension: 256 },
    incrementalMetadataRunOptions(workspace, signal, 64 * 1024),
  );
  if (String(result?.stderr ?? '').trim()) {
    fail(
      'INCREMENTAL_BLEED_BOX_POPPLER_WARNING',
      'Poppler reported a warning while validating the incremental bleed-box PDF.',
      422,
    );
  }
  const bytes = await readRegularOutput(`${prefix}.png`, {
    minimumBytes: PNG_SIGNATURE.length,
    maximumBytes: 32 * 1024 * 1024,
    label: 'Incremental bleed-box validation render',
  });
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'Poppler produced an invalid incremental bleed-box validation render.',
    );
  }
  return bytes;
}

export async function assertIncrementalBleedBoxRendersMatch({
  poppler, sourcePath, outputPath, workspace, signal, pageCount,
}) {
  for (let page = 1; page <= pageCount; page += 1) {
    const sourcePrefix = join(workspace, `source-render-${page}`);
    const outputPrefix = join(workspace, `output-render-${page}`);
    try {
      const [source, output] = await Promise.all([
        render(poppler, sourcePath, sourcePrefix, workspace, signal, page),
        render(poppler, outputPath, outputPrefix, workspace, signal, page),
      ]);
      if (!source.equals(output)) {
        fail(
          'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
          `Incremental bleed-box changed the 256-pixel validation render of page ${page}.`,
        );
      }
    } finally {
      await Promise.allSettled([
        unlink(`${sourcePrefix}.png`),
        unlink(`${outputPrefix}.png`),
      ]);
    }
  }
}
