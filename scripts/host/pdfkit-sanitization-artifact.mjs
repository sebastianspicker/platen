import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeResult(child);
  return Object.freeze(value);
}

export async function promotePdfKitSanitizationArtifact({ store, documentId, source, outputPath, outputDigest, categories, pageCount, signal, profile, limitations }) {
  const provenance = createOperationProvenance({
    type: 'pdfkit-metadata-sanitization', inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile, removedCategories: categories },
    expected: { pageCount, sourceUnchanged: true, rasterized: false, metadataAbsent: categories },
    validation: { passed: true, validators: ['source-sha256', 'pinned-helper-sha256', 'pdfkit-fresh-document-copy', 'pdfkit-content-snapshot-match', 'pdfkit-metadata-absent', 'poppler-document-info-absent', 'poppler-xmp-absent', 'poppler-custom-info-absent', 'pdfsig-output-unsigned', 'poppler-page-count', 'poppler-render-all-pages', 'artifact-sha256'], pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, {
    displayName: `${stem}-metadata-sanitized.pdf`, operation: provenance, expectedSha256: outputDigest, signal,
  });
  return freezeResult({
    kind: 'pdfkit-metadata-sanitization', sourceDigest: source.sha256, artifact,
    sanitization: { profile, removedCategories: categories },
    evidence: { helperBinaryDigestVerified: true, sourceDigestReverified: true, nativeFreshDocumentCopy: true, nativeContentSnapshotMatched: true, nativeMetadataAbsent: true, popplerMetadataAbsent: true, popplerCustomMetadataAbsent: true, outputUnsigned: true, allPagesRendered: true, artifactDigestBound: true, sourceUnchanged: true },
    limitations,
  });
}
