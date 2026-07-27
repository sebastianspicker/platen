import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

export const PDF_ATTACHMENT_REMOVAL_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy',
  'poppler-attachment-extract-before-after', 'raw-logical-deletion-proof',
  'raw-closed-rewrite-proof', 'poppler-page-count-text-boxes',
  'poppler-render-equality-256px-all-pages', 'pdfsig-output-unsigned',
  'artifact-sha256',
]);
export const PDF_ATTACHMENT_REMOVAL_LIMITATIONS = Object.freeze([
  'Only a bounded classic-xref source with one exact flat document-level attachment locus and one matching 1–240-byte printable-ASCII name is accepted.',
  'The one attachment is removed through verified logical deletion and a closed rewrite. Actions, forms, signatures, active content, shared targets, and unsupported graphs fail closed.',
  'The source remains unchanged. This is not attachment addition, extraction, rename, multi-attachment management, or signature preservation.',
]);

export async function promotePdfAttachmentRemovalArtifact({
  store,
  documentId,
  source,
  outputPath,
  outputDigest,
  pageCount,
  removal,
  signal,
}) {
  const operation = createOperationProvenance({
    type: 'pdf-document-attachment-removal',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: removal,
    expected: {
      pageCount, attachmentRemoved: true, sourceUnchanged: true,
      closedClassicRewrite: true, priorRevisionsAbsent: true, rasterized: false,
    },
    validation: {
      passed: true, validators: PDF_ATTACHMENT_REMOVAL_VALIDATORS,
      pageCount, outputSha256: outputDigest,
    },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, {
    displayName: `${stem}-attachment-removed.pdf`,
    operation,
    expectedSha256: outputDigest,
    signal,
  });
  return Object.freeze({
    kind: 'pdf-document-attachment-removal',
    sourceDigest: source.sha256,
    artifact,
    removal: Object.freeze(removal),
    evidence: Object.freeze({
      sourceDigestReverified: true,
      attachmentMatchedBefore: true,
      attachmentContentDigestBound: true,
      attachmentAbsentAfter: true,
      logicalDeletionVerified: true,
      closedClassicRewriteVerified: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageBoxesMatched: true,
      pageValidationRendersMatched: true,
      outputUnsigned: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    }),
    limitations: PDF_ATTACHMENT_REMOVAL_LIMITATIONS,
  });
}
