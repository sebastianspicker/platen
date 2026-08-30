import { promotePdfKitMutationArtifact } from './pdfkit-mutation-artifact.mjs';
import { fail } from './pdfkit-mutation-operation-errors.mjs';

export async function promotePdfKitMutationOperation(context) {
  const artifactResult = await promotePdfKitMutationArtifact({
    store: context.store,
    documentId: context.documentId,
    source: context.source,
    outputPath: context.outputPath,
    signal: context.job.signal,
    normalized: context.normalized,
    pageBoxEvidence: context.pageBoxEvidence,
    sourceInspection: context.sourceInspection,
    outputInspection: context.outputInspection,
    outputDigest: context.validated.outputDigest,
    nativeResult: context.result,
  });
  if (artifactResult.artifact.sha256 !== context.validated.outputDigest) {
    fail('PDFKIT_OUTPUT_INVALID', 'The promoted PDF does not match the validated output.', 502);
  }
  return artifactResult;
}
