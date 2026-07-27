import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

export const PDF_INCREMENTAL_BLEED_BOX_PROFILE = 'local-classic-incremental-bleed-box-v1';
export const PDF_INCREMENTAL_BLEED_BOX_LIMITATIONS = Object.freeze([
  'Only the supported bounded xref subset is accepted; admitted xref/object streams may use the fixed control-filter pipelines, while encrypted, signed, form, JavaScript, XMP, attachment, and URL-bearing PDFs are rejected.',
  'The output is a structure-preserving append-only revision: prior source bytes remain exactly present and the selected page object is revised in place.',
  'Validation establishes fixed 256-pixel-long-edge Poppler PNG byte equality for every page, not broader visual, semantic, or print-production equivalence.',
]);
export const PDF_INCREMENTAL_BLEED_BOX_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'classic-xref-proof', 'poppler-page-count',
  'poppler-page-text', 'poppler-page-boxes', 'poppler-render-equality-256px-all-pages',
  'pdfsig-output-unsigned', 'xmp-absent', 'source-unchanged', 'artifact-sha256',
]);

function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }

export async function promoteIncrementalBleedBoxArtifact({ store, documentId, source, outputPath, outputDigest, pageCount, request, signal }) {
  const operation = createOperationProvenance({
    type: 'pdf-incremental-bleed-box', inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: request,
    expected: { pageCount, sourceUnchanged: true, sourcePrefixPreserved: true, samePageObjectRevision: true, rasterized: false },
    validation: { passed: true, validators: PDF_INCREMENTAL_BLEED_BOX_VALIDATORS, pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-page-${request.page}-bleed-box.pdf`, operation, expectedSha256: outputDigest, signal });
  return freeze({
    kind: 'pdf-incremental-bleed-box', sourceDigest: source.sha256, artifact,
    pageBox: request,
    evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, onlyTargetBleedBoxChanged: true, samePageObjectRevision: true, classicIncrementalRevisionAppended: true, pageCountMatched: true, pageTextMatched: true, nonTargetPageBoxesMatched: true, selectedMediaCropTrimArtMatched: true, selectedBleedBoxMatched: true, pageValidationRendersMatched: true, outputUnsigned: true, xmpAbsent: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: PDF_INCREMENTAL_BLEED_BOX_LIMITATIONS,
  });
}
