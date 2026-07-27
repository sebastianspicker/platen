import { basename, extname } from 'node:path';
import { createOperationProvenance } from './operation-provenance.mjs';

export const PDF_ANNOTATION_FLATTEN_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-locator-appearance-compact-proof',
  'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);
export const PDF_ANNOTATION_FLATTEN_LIMITATIONS = Object.freeze([
  'Only one source-bound /Square annotation in the entire bounded document is accepted. It must have the Print flag and one tiny, unfiltered, resource-free normal appearance stream.',
  'The selected page must be unrotated and use direct page resources without existing XObjects. Appearance state dictionaries, widgets, actions, popups, filters, resources, groups, optional content, and unsupported graphs fail closed.',
  'The result is a fresh closed rewrite that promotes the admitted appearance into page content and removes prior revisions and the annotation object. It is not general annotation flattening, sanitization, or signature preservation.',
]);

export async function promotePdfAnnotationFlattenArtifact({ store, documentId, source, outputPath, outputDigest, pageCount, request, signal }) {
  const operation = createOperationProvenance({
    type: 'pdf-square-annotation-flatten',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: request.profile, page: request.target.page, annotationIndex: request.target.annotationIndex, subtype: request.target.subtype },
    expected: { pageCount, flattenedAnnotationCount: 1, sourceUnchanged: true, closedClassicRevision: true, priorRevisionsAbsent: true, rasterized: false },
    validation: { passed: true, validators: PDF_ANNOTATION_FLATTEN_VALIDATORS, pageCount, outputSha256: outputDigest },
  });
  const stem = basename(source.displayName, extname(source.displayName));
  const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-square-annotation-flattened.pdf`, operation, expectedSha256: outputDigest, signal });
  return Object.freeze({
    kind: 'pdf-square-annotation-flatten', sourceDigest: source.sha256, artifact,
    flatten: Object.freeze({ profile: request.profile, page: request.target.page, annotationIndex: request.target.annotationIndex, subtype: 'square' }),
    evidence: Object.freeze({ sourceDigestReverified: true, locatorRederived: true, normalAppearanceVerified: true, appearancePromotedToPageContent: true, annotationRemoved: true, removedReferenceUnresolvable: true, closedClassicRevision: true, priorRevisionsAbsent: true, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true, pageValidationRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }),
    limitations: PDF_ANNOTATION_FLATTEN_LIMITATIONS,
  });
}
