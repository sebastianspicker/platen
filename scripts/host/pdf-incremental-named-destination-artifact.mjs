import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

export const PDF_INCREMENTAL_NAMED_DESTINATION_PROFILE = 'local-incremental-named-destination-v1';
export const PDF_INCREMENTAL_NAMED_DESTINATION_LIMITATIONS = Object.freeze([
  'Only bounded classic or admitted xref/object-stream sources with no existing name tree or legacy destinations are accepted.',
  'Exactly one 1-64 character ASCII name is added with a direct local /Fit target. Page annotations, actions, forms, signatures, active content, and unsupported graphs fail closed.',
  'A classic append-only revision is added. Historical source bytes remain present; this is not general destination management, sanitization, or signature preservation.',
]);
export const PDF_INCREMENTAL_NAMED_DESTINATION_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-incremental-proof', 'poppler-named-destination-before-after', 'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages', 'pdfsig-output-unsigned', 'artifact-sha256',
]);

export async function promoteIncrementalNamedDestinationArtifact({ store, documentId, source, outputPath, outputDigest, pageCount, request, signal }) {
  const destination = Object.freeze({ profile: request.profile, targetPage: request.targetPage, nameSha256: createHash('sha256').update(request.name, 'ascii').digest('hex'), fit: true });
  const operation = createOperationProvenance({
    type: 'pdf-incremental-named-destination',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: request.profile, targetPage: request.targetPage, nameSha256: destination.nameSha256 },
    expected: { pageCount, namedDestinationAdded: true, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
    validation: { passed: true, validators: PDF_INCREMENTAL_NAMED_DESTINATION_VALIDATORS, pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, {
    displayName: `${stem}-named-destination.pdf`, operation, expectedSha256: outputDigest, signal,
  });
  return Object.freeze({
    kind: 'pdf-incremental-named-destination', sourceDigest: source.sha256, artifact,
    destination,
    evidence: Object.freeze({ sourceDigestReverified: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, namedDestinationAbsentBefore: true, namedDestinationMatched: true, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true, pageValidationRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }),
    limitations: PDF_INCREMENTAL_NAMED_DESTINATION_LIMITATIONS,
  });
}
