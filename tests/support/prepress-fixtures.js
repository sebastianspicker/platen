import { createHash } from 'node:crypto';
import { buildPreflightReport } from '../../scripts/host/preflight-rules.mjs';

export const PREPRESS_SOURCE = 'a'.repeat(64);
export const PREPRESS_OUTPUT = 'b'.repeat(64);
export const PREPRESS_PROFILE = 'c'.repeat(64);
export const PREPRESS_DOCUMENT = '123e4567-e89b-12d3-a456-426614174000';
const PREPRESS_ARTIFACT = '123e4567-e89b-42d3-a456-426614174000';
const PREPRESS_OPERATION = '123e4567-e89b-42d3-a456-426614174001';
const PREPRESS_TIME = '2026-08-03T10:00:00.000Z';

function prepressProfile() {
  return { id: 'ghostscript-default-cmyk', description: 'Ghostscript bundled default CMYK profile', version: '10.0.0', deviceClass: 'output', colorSpace: 'CMYK', connectionSpace: 'Lab', renderingIntent: 1, size: 512, sha256: PREPRESS_PROFILE, tagCount: 4 };
}

function prepressArtifact(type, parameters, expected, pageCount, validators, validationExtras = {}) {
  return { id: PREPRESS_ARTIFACT, documentId: PREPRESS_DOCUMENT, displayName: 'production-cmyk.pdf', mediaType: 'application/pdf', size: 2048, sha256: PREPRESS_OUTPUT, createdAt: PREPRESS_TIME,
    operation: { schemaVersion: 1, id: PREPRESS_OPERATION, type, inputs: [{ documentId: PREPRESS_DOCUMENT, sha256: PREPRESS_SOURCE, role: 'source' }], parameters, expected, validation: { passed: true, validators, outputSha256: PREPRESS_OUTPUT, pageCount, textSha256: 'd'.repeat(64), ...validationExtras }, completedAt: PREPRESS_TIME } };
}

export function strictPrepressResult(operation) {
  const descriptor = prepressProfile();
  const pageCount = 2;
  if (operation === 'icc-convert') {
    return {
      kind: 'icc-cmyk-artifact', schemaVersion: 1, sourceDigest: PREPRESS_SOURCE,
      artifact: prepressArtifact('ghostscript-icc-cmyk', { profileId: descriptor.id, profileSha256: PREPRESS_PROFILE, renderingIntent: 'relative-colorimetric', blackPointCompensation: true, preserveSeparations: true, overrideEmbeddedIcc: false }, { pageCount, outputColorSpace: 'CMYK-targeted', rasterized: false }, pageCount, ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256']),
      profile: descriptor, recipe: { colorConversionStrategy: 'CMYK', renderingIntent: 'relative-colorimetric', blackPointCompensation: true, preservesSeparationAndDeviceN: true, overrideEmbeddedIcc: false, downsampling: false },
      receipt: { engine: { name: 'Ghostscript', version: '10.0.0' }, outputSha256: PREPRESS_OUTPUT, pageCount, pageGeometryPreserved: true, textExtractionEquivalent: true, everyPageRendered: true, outputIntentEmbeddedOrValidated: false, pdfXValidated: false },
      authoritative: false, limitations: ['This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.', 'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.', 'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.'],
    };
  }
  if (operation === 'imposition') {
    const layout = { id: '2x2', across: 2, down: 2, order: 'upper-left-row-major', sourcePageCount: 3, sheetCount: 1, sourcePage: { widthPoints: 612, heightPoints: 792, rotation: 0 }, sheet: { widthPoints: 1224, heightPoints: 1584 }, marks: 'none' };
    return {
      kind: 'imposition-artifact', schemaVersion: 1, sourceDigest: PREPRESS_SOURCE,
      artifact: prepressArtifact('ghostscript-nup-imposition', { layout: '2x2', across: 2, down: 2, order: 'upper-left-row-major', marks: false }, { pageCount: 1, sheetWidthPoints: 1224, sheetHeightPoints: 1584, rasterized: false }, 1, ['source-sha256', 'uniform-source-page-geometry', 'ghostscript-exit-zero', 'poppler-page-count', 'poppler-sheet-geometry', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256']),
      layout, receipt: { engine: { name: 'Ghostscript', version: '10.0.0' }, outputSha256: PREPRESS_OUTPUT, pageCount: 1, vectorOrientedPdfwriteRewrite: true, unconditionalVectorPreservationClaim: false, textExtractionEquivalent: true, everySheetRendered: true, pdfXValidated: false },
      authoritative: false, limitations: ['This is bounded row-major N-up, not booklet, signature, creep, gutter, step-and-repeat, or production imposition.', 'Printer marks are unavailable because the installed engine has no validated production marks contract.', 'Ghostscript writes a new vector-oriented PDF but may rewrite or rasterize unsupported constructs; links, destinations, tags, annotations, forms, optional content, and signatures are not preserved by contract.'],
    };
  }
  return {
    kind: 'output-intent-artifact', schemaVersion: 1, sourceDigest: PREPRESS_SOURCE,
    artifact: prepressArtifact('ghostscript-cmyk-output-intent', { profileId: descriptor.id, profileSha256: PREPRESS_PROFILE, profileBytes: descriptor.size, outputIntentSubtype: 'GTS_PDFX', closedClassicRevision: true, priorRevisionsAbsent: true }, { pageCount, outputIntentCount: 1, embeddedProfileSha256: PREPRESS_PROFILE, pdfXValidated: false }, pageCount, ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'output-intent-structure', 'closed-classic-rewrite', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256'], { outputIntentCount: 1, profileSha256: PREPRESS_PROFILE }),
    profile: descriptor,
    proof: { schema: 'pdf-output-intent-assignment-proof-v1', version: 1, sourceSha256: PREPRESS_SOURCE, outputSha256: PREPRESS_OUTPUT, profileSha256: PREPRESS_PROFILE, profileBytes: descriptor.size, sourceObjectCount: 3, outputObjectCount: 5, objectDelta: 2, xrefDelta: 2, outputIntentCount: 1, pageCount, pageTreeNodeCount: 1, pagesTextBoxesRendersUnchangedExpected: true, closedClassicRevision: true, priorRevisionsAbsent: true, limitation: 'Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.', transaction: { profileObjectNumber: 20, outputIntentObjectNumber: 21, appendedXrefOffset: 800 }, compactRewrite: { reachableObjectCount: 5, outputBytes: 2048 } },
    receipt: { outputSha256: PREPRESS_OUTPUT, pageCount, pageGeometryPreserved: true, textExtractionEquivalent: true, everyPageRendered: true, outputIntentCount: 1, pdfXValidated: false },
    authoritative: false,
    limitations: ['Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.'],
  };
}

export function archivePreflightReview() {
  return buildPreflightReport({
    profile: 'archive-review',
    document: { sha256: PREPRESS_SOURCE },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' },
    structure: {
      sourceDigest: PREPRESS_SOURCE,
      pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{
        page: 1, widthPoints: 612, heightPoints: 792,
        boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 } },
      }],
      xmpMetadata: { present: true },
    },
    fonts: [],
    images: [],
  });
}

export const OUTPUT_INTENT_PROFILE = 'local-ghostscript-default-cmyk-output-intent-v1';
export const OUTPUT_INTENT_LIMITATION = 'Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.';

export function outputIntentResult({ documentId, sourceSha256, outputSha256 = createHash('sha256').update('OUTPUT INTENT ARTIFACT').digest('hex'), createdAt = '2026-08-03T00:00:00.000Z' }) {
  const profileSha256 = PREPRESS_PROFILE;
  const profile = prepressProfile();
  const operationId = '22222222-2222-4222-8222-222222222222';
  const artifactId = '33333333-3333-4333-8333-333333333333';
  return {
    kind: 'output-intent-artifact', schemaVersion: 1, sourceDigest: sourceSha256,
    artifact: { id: artifactId, documentId, displayName: 'output-intent.pdf', mediaType: 'application/pdf', size: 2048, sha256: outputSha256, createdAt,
      operation: { schemaVersion: 1, id: operationId, type: 'ghostscript-cmyk-output-intent', inputs: [{ documentId, sha256: sourceSha256, role: 'source' }], parameters: { profileId: profile.id, profileSha256, profileBytes: profile.size, outputIntentSubtype: 'GTS_PDFX', closedClassicRevision: true, priorRevisionsAbsent: true }, expected: { pageCount: 1, outputIntentCount: 1, embeddedProfileSha256: profileSha256, pdfXValidated: false }, validation: { passed: true, validators: ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'output-intent-structure', 'closed-classic-rewrite', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256'], outputSha256, pageCount: 1, textSha256: 'd'.repeat(64), outputIntentCount: 1, profileSha256 }, completedAt: createdAt } },
    profile,
    proof: { schema: 'pdf-output-intent-assignment-proof-v1', version: 1, sourceSha256, outputSha256, profileSha256, profileBytes: profile.size, sourceObjectCount: 3, outputObjectCount: 5, objectDelta: 2, xrefDelta: 2, outputIntentCount: 1, pageCount: 1, pageTreeNodeCount: 1, pagesTextBoxesRendersUnchangedExpected: true, closedClassicRevision: true, priorRevisionsAbsent: true, limitation: OUTPUT_INTENT_LIMITATION, transaction: { profileObjectNumber: 20, outputIntentObjectNumber: 21, appendedXrefOffset: 800 }, compactRewrite: { reachableObjectCount: 5, outputBytes: 2048 } },
    receipt: { outputSha256, pageCount: 1, pageGeometryPreserved: true, textExtractionEquivalent: true, everyPageRendered: true, outputIntentCount: 1, pdfXValidated: false },
    authoritative: false, limitations: [OUTPUT_INTENT_LIMITATION],
  };
}
