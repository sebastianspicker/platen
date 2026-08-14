import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

export const PDF_INCREMENTAL_GOTO_LINK_PROFILE = 'local-incremental-goto-link-v1';
export const PDF_INCREMENTAL_GOTO_LINK_LIMITATIONS = Object.freeze([
  'Only bounded classic or admitted xref/object-stream sources with fixed control filters are accepted. Every leaf needs explicit integer MediaBox and CropBox containment.',
  'Existing annotations are limited to a passive whitelist with no links or actions; the new annotation is one direct /Dest /Fit link. This is not general hyperlink support or sanitization.',
  'A classic append-only revision is added. Historical source bytes remain present; this does not preserve signatures or establish broader semantic or print-production equivalence.',
]);
export const PDF_INCREMENTAL_GOTO_LINK_VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'raw-incremental-proof', 'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages', 'pdfsig-output-unsigned', 'artifact-sha256']);
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }

export async function promoteIncrementalGoToLinkArtifact({ store, documentId, source, outputPath, outputDigest, pageCount, request, signal }) {
  const operation = createOperationProvenance({
    type: 'pdf-incremental-goto-link', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: request,
    expected: { pageCount, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
    validation: { passed: true, validators: PDF_INCREMENTAL_GOTO_LINK_VALIDATORS, pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-goto-link.pdf`, operation, expectedSha256: outputDigest, signal });
  return freeze({
    kind: 'pdf-incremental-goto-link', sourceDigest: source.sha256, artifact,
    link: { sourcePage: request.sourcePage, targetPage: request.targetPage, rect: request.rect },
    evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true, pageValidationRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: PDF_INCREMENTAL_GOTO_LINK_LIMITATIONS,
  });
}
