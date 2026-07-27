import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

export const PDF_INCREMENTAL_METADATA_PROFILE = 'local-classic-incremental-metadata-v1';
export const PDF_INCREMENTAL_METADATA_FIELDS = Object.freeze(['title', 'author', 'subject', 'keywords']);
export const PDF_INCREMENTAL_METADATA_LIMITATIONS = Object.freeze([
  'Only the supported bounded xref subset is accepted; admitted xref/object streams may use the fixed control-filter pipelines, while encryption, signatures, XMP, and inputs where Poppler detects forms, JavaScript, attachments, or URLs are rejected.',
  'The append-only revision retains historical metadata bytes in prior revisions.',
  'This operation is not sanitization or privacy removal, and its explicit gates do not establish broader active-content safety.',
]);

export const PDF_INCREMENTAL_METADATA_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'classic-xref-proof', 'poppler-metadata',
  'pdfsig-output-unsigned', 'poppler-page-count', 'poppler-page-text',
  'poppler-page-boxes', 'poppler-render-all-pages', 'xmp-absent',
  'source-unchanged', 'artifact-sha256',
]);

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeResult(child);
  return Object.freeze(value);
}

export async function promoteIncrementalMetadataArtifact({
  store, documentId, source, outputPath, outputDigest, pageCount, signal,
}) {
  const operation = createOperationProvenance({
    type: 'pdf-incremental-metadata',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: PDF_INCREMENTAL_METADATA_PROFILE, updatedFields: PDF_INCREMENTAL_METADATA_FIELDS },
    expected: { pageCount, sourceUnchanged: true, sourcePrefixPreserved: true, rasterized: false },
    validation: { passed: true, validators: PDF_INCREMENTAL_METADATA_VALIDATORS, pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, {
    displayName: `${stem}-metadata-updated.pdf`, operation, expectedSha256: outputDigest, signal,
  });
  return freezeResult({
    kind: 'pdf-incremental-metadata',
    sourceDigest: source.sha256,
    artifact,
    metadata: { profile: PDF_INCREMENTAL_METADATA_PROFILE, updatedFields: PDF_INCREMENTAL_METADATA_FIELDS },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      priorObjectOffsetsPreserved: true,
      rootReferencePreserved: true,
      freshInfoObjectAllocated: true,
      classicIncrementalRevisionAppended: true,
      popplerMetadataMatched: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageGeometryMatched: true,
      pageRendersMatched: true,
      outputUnsigned: true,
      xmpAbsent: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: PDF_INCREMENTAL_METADATA_LIMITATIONS,
  });
}
