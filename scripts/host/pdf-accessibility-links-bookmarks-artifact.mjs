import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';
import { PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE } from './pdf-accessibility-links-bookmarks-contract.mjs';

export const PDF_ACCESSIBILITY_LINKS_BOOKMARKS_LIMITATIONS = Object.freeze([
  'Only one unsigned, unencrypted, non-compressed classic PDF revision is accepted.',
  'Only existing direct Link annotations and existing outline items with direct internal /Fit page destinations are repaired; bounded requests may retarget those destinations to exact source pages. URI, external, JavaScript, action, signature, form, layer, attachment, and ambiguous graphs are rejected.',
  'Link purpose and bookmark text are human-authored bounded strings. The append-only revision preserves page content, geometry, and outline hierarchy but is not a claim of broad PDF/UA or viewer equivalence.',
]);

export async function promoteAccessibilityLinksBookmarksArtifact({ store, documentId, source, outputPath, outputSha256, request, evidence, signal }) {
  const stem = basename(source.displayName, extname(source.displayName));
  const operation = createOperationProvenance({
    type: 'pdf-accessibility-links-bookmarks',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: request.profile, sourceSha256: request.sourceSha256, linkCount: request.links.length, bookmarkCount: request.bookmarks.length },
    expected: { sourceUnchanged: true, sourcePrefixPreserved: true, geometryPreserved: true, hierarchyPreserved: true },
    validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'classic-single-revision-proof', 'raw-reinspection', 'artifact-sha256'], outputSha256, profile: PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE, ...evidence },
  });
  const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-links-bookmarks.pdf`, operation, expectedSha256: outputSha256, signal });
  return Object.freeze({ kind: 'pdf-accessibility-links-bookmarks', sourceDigest: source.sha256, artifact, operation, evidence: Object.freeze({ ...evidence, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }), limitations: PDF_ACCESSIBILITY_LINKS_BOOKMARKS_LIMITATIONS });
}
