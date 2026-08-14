import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { createOperationProvenance } from './operation-provenance.mjs';
import { INCREMENTAL_BATCH_LINK_PROFILE } from './pdf-incremental-batch-link-contract.mjs';

export const PDF_INCREMENTAL_BATCH_LINK_LIMITATIONS = Object.freeze([
  'Same-document intra-PDF links only: every destination is a direct /Dest /Fit page reference.',
  'The source must be unsigned, unencrypted, untagged, and free of forms, JavaScript, XMP, attachments, and URL actions.',
  'A classic append-only revision is added; this is not PDF/UA, signature preservation, external-link, or print-certification evidence.',
]);
export const PDF_INCREMENTAL_BATCH_LINK_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-batch-proof', 'raw-reinspection',
  'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);

function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }

export async function promoteIncrementalBatchLinkArtifact({ store, documentId, source, outputPath, outputDigest, pageCount, request, proof, signal }) {
  const operation = createOperationProvenance({
    type: 'pdf-incremental-batch-link', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: request.profile, links: request.links, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') },
    expected: { pageCount, linkCount: request.links.length, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
    validation: { passed: true, validators: PDF_INCREMENTAL_BATCH_LINK_VALIDATORS, pageCount, outputSha256: outputDigest, rawProof: proof },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-batch-link.pdf`, operation, expectedSha256: outputDigest, signal });
  return freeze({
    kind: 'pdf-incremental-batch-link', sourceDigest: source.sha256, artifact,
    links: request.links, evidence: {
      sourceDigestReverified: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true,
      linkCount: request.links.length, pageCount, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true,
      pageValidationRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    }, limitations: PDF_INCREMENTAL_BATCH_LINK_LIMITATIONS,
  });
}
