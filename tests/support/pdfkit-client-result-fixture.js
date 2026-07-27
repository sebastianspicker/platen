import { expectedPdfKitMutationResult } from '../../src/core/pdfkit-client-mutation-result-expectations.js';

const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const outputSha256 = 'c'.repeat(64);
const timestamp = '2026-07-19T12:00:00.000Z';

export function pdfKitClientMutationResult({
  documentId,
  sourceSha256,
  profile,
  mutation,
}) {
  const expected = expectedPdfKitMutationResult(profile, mutation);
  const validation = {
    passed: true,
    validators: [...expected.validators],
    pageCount: 2,
    renderedPages: 2,
    appliedEdits: expected.editCount,
    outputSha256,
    ...(expected.rotation ? {
      rotatedPage: expected.rotation.page,
      pageRotation: expected.rotation.degrees,
    } : {}),
    ...(expected.pageBox?.box === 'crop' ? {
      croppedPage: expected.pageBox.page,
      persistentCropBox: { ...expected.pageBox.rect },
    } : {}),
    ...(expected.pageBox?.box === 'bleed' ? {
      bleedBoxPage: expected.pageBox.page,
      persistentBleedBox: { ...expected.pageBox.rect },
    } : {}),
  };
  return {
    kind: expected.kind,
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'derived.pdf',
      mediaType: 'application/pdf',
      size: 1_024,
      sha256: outputSha256,
      operation: {
        schemaVersion: 1,
        id: operationId,
        type: expected.type,
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: structuredClone(expected.parameters),
        expected: { pageCount: 2, rasterized: false, editCount: expected.editCount },
        validation,
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    appliedEdits: expected.editCount,
    postflight: {},
    evidence: { ...expected.evidence },
    limitations: ['Fixed local profile.', 'Source retained.', 'Not byte preserving.'],
  };
}
