import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../../src/core/local-host-client.js';

const token = 'a'.repeat(64);

function ocrDocumentResult(documentId = 'doc', language = 'eng') {
  const cleanupReceipts = [{ page: 1, applied: true, preset: 'document', canvasPreserved: true, pre: { sha256: 'd'.repeat(64), width: 1, height: 1 }, post: { sha256: 'e'.repeat(64), width: 1, height: 1 } }];
  return {
    kind: 'searchable-ocr-document', schemaVersion: 1, sourceDigest: 'b'.repeat(64),
    artifact: { id: 'artifact', documentId, displayName: 'ocr.pdf', mediaType: 'application/pdf', size: 1, sha256: 'c'.repeat(64), operation: { schemaVersion: 1, type: 'searchable-ocr', inputs: [{ documentId, sha256: 'b'.repeat(64) }], parameters: { cleanupReceipts, userDictionary: { termCount: 0, digest: null } }, validation: { passed: true, recognizedWordCount: 1 } }, createdAt: '2026-01-01T00:00:00.000Z' },
    result: { language, pageCount: 1, recognizedWordCount: 1, rasterized: true, cleanupPreset: 'document', segmentation: 'auto', userDictionary: { termCount: 0, digest: null }, suspects: [] },
    evidence: { localOnly: true, sourceBound: true, engines: ['Poppler', 'ImageMagick', 'Tesseract'], rasterized: true, reviewRequired: true, cleanupReceipts },
    limitations: ['Review OCR output.'],
  };
}

function ocrLayoutResult(language = 'eng') {
  return {
    kind: 'ocr-layout-evidence', schemaVersion: 1, sourceDigest: 'b'.repeat(64), language,
    cleanupPreset: 'document', segmentation: 'auto', detectTables: false,
    records: [{ page: 1, pageSize: { page: 1, widthPoints: 612, heightPoints: 792 }, zoneId: 'image-1', zoneType: 'image', region: { x: 0, y: 0, width: 1, height: 1 }, dpi: 300, classificationOnly: true, recognizedWordCount: 0, layout: null, tableCandidates: [], alto: null }],
    evidence: { localOnly: true, sourceBound: true, engines: ['Poppler', 'ImageMagick', 'Tesseract'], tableMethod: null, reviewRequired: false },
    limitations: ['Coordinates require review.', 'No authoritative table structure.'],
  };
}

function aecSourceBinding() {
  return {
    sha256: 'b'.repeat(64), page: 1, displayBox: 'crop',
    box: { left: 0, bottom: 0, right: 612, top: 792 }, rotation: 0,
    geometrySha256: 'c'.repeat(64),
  };
}

function aecCalibrationResult() {
  return {
    kind: 'source-bound-aec-calibration', schemaVersion: 1, sourceDigest: 'b'.repeat(64), workspaceRevision: 1,
    calibration: {
      schemaVersion: 2, id: 'calibration-1', type: 'scale-calibration', source: aecSourceBinding(),
      segment: [{ x: 0, y: 0 }, { x: 72, y: 0 }], knownLength: { value: 1, unit: 'ft' },
      metersPerPdfPoint: 0.3048 / 72, label: 'Plan scale', createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function aecMeasurementResult() {
  return {
    kind: 'source-bound-aec-measurement', schemaVersion: 1, sourceDigest: 'b'.repeat(64), workspaceRevision: 2,
    measurement: {
      schemaVersion: 2, id: 'measurement-1', type: 'measurement', source: aecSourceBinding(),
      calibrationId: 'calibration-1', kind: 'distance',
      geometry: { space: 'pdf-user-space-v1', points: [{ x: 0, y: 0 }, { x: 72, y: 0 }] },
      result: { dimension: 'length', siValue: 0.3048, siUnit: 'm', displayValue: 1, displayUnit: 'ft' },
      label: 'Wall', provenanceSha256: 'd'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function protectionRemovalResult({ documentId, sourceSha256, protectedSha256 }) {
  const outputSha256 = 'e'.repeat(64);
  const sourceProtectionProfile = 'accessibility-only';
  const operation = {
    schemaVersion: 1,
    id: '44444444-4444-4444-8444-444444444444',
    type: 'pdfkit-protection-removal',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: {
      profile: 'macos-pdfkit-remove-protection-v1',
      protectedArtifactSha256: protectedSha256,
      sourceProtectionProfile,
    },
    expected: {
      pageCount: 1, encrypted: false, sourceUnchanged: true, protectedArtifactRetained: true,
    },
    validation: {
      passed: true,
      validators: [
        'protected-artifact-provenance', 'source-sha256', 'fixed-aes128-envelope',
        'native-owner-authorization', 'native-private-snapshot-match',
        'classic-xref-no-encrypt', 'poppler-unauthenticated-open',
        'poppler-all-page-render', 'artifact-sha256',
      ],
      pageCount: 1,
      outputSha256,
    },
    completedAt: '2026-07-19T00:00:00.000Z',
  };
  return {
    kind: 'pdfkit-protection-removal',
    sourceDigest: protectedSha256,
    artifact: {
      id: '33333333-3333-4333-8333-333333333333',
      documentId,
      displayName: 'source-unprotected.pdf',
      mediaType: 'application/pdf',
      size: 128,
      sha256: outputSha256,
      operation,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
    protection: {
      profile: 'macos-pdfkit-remove-protection-v1',
      sourceProtectionProfile,
      ownerAuthorizationVerified: true,
      encrypted: false,
    },
    evidence: {
      protectedArtifactProvenanceVerified: true,
      sourceEnvelopeValidated: true,
      ownerAuthorizationVerified: true,
      nativeContentChecksPassed: true,
      finalTrailerUnencrypted: true,
      popplerUnauthenticatedOpenPassed: true,
      allPagesRendered: true,
      artifactDigestBound: true,
      encryptedSourceRetained: true,
    },
    limitations: [
      'Current retained fixed-profile artifact only.',
      'Separate cleartext copy; protected sources remain.',
      'Not recovery, arbitrary decryption, or secure erasure.',
    ],
  };
}

function metadataSanitizationResult({ documentId, sourceSha256 }) {
  const outputSha256 = 'e'.repeat(64);
  const removedCategories = ['document-info', 'custom-info', 'xmp'];
  const operation = {
    schemaVersion: 1,
    id: '44444444-4444-4444-8444-444444444444',
    type: 'pdfkit-metadata-sanitization',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: {
      profile: 'macos-pdfkit-metadata-sanitize-v1', removedCategories,
    },
    expected: {
      pageCount: 1, sourceUnchanged: true, rasterized: false,
      metadataAbsent: removedCategories,
    },
    validation: {
      passed: true,
      validators: [
        'source-sha256', 'pinned-helper-sha256', 'pdfkit-fresh-document-copy',
        'pdfkit-content-snapshot-match', 'pdfkit-metadata-absent',
        'poppler-document-info-absent', 'poppler-xmp-absent',
        'poppler-custom-info-absent', 'pdfsig-output-unsigned',
        'poppler-page-count', 'poppler-render-all-pages', 'artifact-sha256',
      ],
      pageCount: 1,
      outputSha256,
    },
    completedAt: '2026-07-19T00:00:00.000Z',
  };
  return {
    kind: 'pdfkit-metadata-sanitization',
    sourceDigest: sourceSha256,
    artifact: {
      id: '33333333-3333-4333-8333-333333333333',
      documentId,
      displayName: 'source-metadata-sanitized.pdf',
      mediaType: 'application/pdf',
      size: 128,
      sha256: outputSha256,
      operation,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
    sanitization: {
      profile: 'macos-pdfkit-metadata-sanitize-v1', removedCategories,
    },
    evidence: {
      helperBinaryDigestVerified: true,
      sourceDigestReverified: true,
      nativeFreshDocumentCopy: true,
      nativeContentSnapshotMatched: true,
      nativeMetadataAbsent: true,
      popplerMetadataAbsent: true,
      popplerCustomMetadataAbsent: true,
      outputUnsigned: true,
      allPagesRendered: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
    },
    limitations: [
      'This fixed profile removes document Info entries, custom Info entries, and catalog XMP only from a separate derived PDF.',
      'It rejects signatures, encryption, forms, tags, layers, name trees, page labels, active content, attachments, URLs, and unsupported page or catalog graphs instead of silently discarding them.',
      'This is not hidden-data sanitization, prior-revision or orphan-object scrubbing, secure erasure, signature preservation, or byte preservation.',
    ],
  };
}

export {
  aecCalibrationResult,
  aecMeasurementResult,
  aecSourceBinding,
  assert,
  LocalHostClient,
  metadataSanitizationResult,
  ocrDocumentResult,
  ocrLayoutResult,
  protectionRemovalResult,
  token,
};

