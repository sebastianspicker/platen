import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';
import { INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE } from './pdf-incremental-accessibility-metadata-contract.mjs';

const FIELDS = Object.freeze(['documentDefaultLanguage', 'infoTitle']);
const VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'raw-lang-title-proof', 'pdfsig-output-unsigned', 'poppler-page-count', 'poppler-page-text', 'poppler-page-boxes', 'poppler-render-all-pages', 'source-unchanged', 'artifact-sha256']);
const LIMITATIONS = Object.freeze(['The append-only revision retains historical bytes and metadata in prior revisions.', 'This operation does not add content-item language, tags, a structure tree, PDF/UA conformance, sanitization, or signature preservation.']);

function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

export async function promoteIncrementalAccessibilityMetadataArtifact({ store, documentId, source, outputPath, outputDigest, pageCount, request, signal }) {
  const requestSha256 = createHash('sha256').update(JSON.stringify({
    language: request.language,
    title: request.title,
  })).digest('hex');
  const operation = createOperationProvenance({ type: 'pdf-incremental-accessibility-metadata', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, updatedFields: FIELDS, requestSha256 }, expected: { pageCount, sourceUnchanged: true, sourcePrefixPreserved: true, rasterized: false }, validation: { passed: true, validators: VALIDATORS, pageCount, outputSha256: outputDigest } });
  const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: `${basename(source.displayName, extname(source.displayName))}-language-title-updated.pdf`, operation, expectedSha256: outputDigest, signal });
  return freeze({ kind: 'pdf-incremental-accessibility-metadata', sourceDigest: source.sha256, artifact, metadata: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, updatedFields: FIELDS, requestSha256 }, evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, appendOnlyHistoryRetained: true, rawLanguageAndTitleMatched: true, outputUnsigned: true, pageCountMatched: true, pageTextMatched: true, pageGeometryMatched: true, pageRendersMatched: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }, limitations: LIMITATIONS });
}
