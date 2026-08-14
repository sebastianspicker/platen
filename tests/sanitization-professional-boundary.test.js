import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import {
  buildPdfHiddenDataSanitization,
  PDF_HIDDEN_DATA_SANITIZER_PROFILE,
} from '../scripts/host/pdf-hidden-data-sanitizer.mjs';
import { PDFKIT_METADATA_SANITIZATION_PROFILE } from '../scripts/host/pdfkit-sanitization-service.mjs';
import {
  opSanitizeHiddenData,
  opSanitizeMetadata,
} from '../scripts/host/professional-capability/real-ops-crypto.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const documentId = 'sanitization-source-document';

function operation(type, sourceSha256, outputSha256) {
  return {
    type,
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    validation: { passed: true, outputSha256 },
  };
}

function artifact(type, sourceSha256, bytes) {
  const outputSha256 = digest(bytes);
  return {
    id: `${type}-artifact`, documentId, displayName: 'sanitized.pdf', mediaType: 'application/pdf',
    size: bytes.length, sha256: outputSha256, operation: operation(type, sourceSha256, outputSha256),
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

function metadataContext() {
  const sourcePdf = createTextPdf({ text: 'SOURCE-CONTENT-MUST-BE-PRESERVED', title: 'Private title' });
  const sourceSha256 = digest(sourcePdf);
  const output = createTextPdf({ text: 'SOURCE-CONTENT-MUST-BE-PRESERVED', title: 'Untitled' });
  const promoted = artifact('pdfkit-metadata-sanitization', sourceSha256, output);
  const calls = [];
  return {
    sourcePdf, sourceSha256, output, promoted, calls,
    context: {
      documentId, sourcePdf, sourceSha256,
      pdfkitSanitization: {
        async sanitizeMetadata(requestedDocumentId, options) {
          calls.push({ requestedDocumentId, options });
          return {
            kind: 'pdfkit-metadata-sanitization', sourceDigest: sourceSha256, artifact: promoted,
            sanitization: {
              profile: PDFKIT_METADATA_SANITIZATION_PROFILE,
              removedCategories: ['document-info'],
            },
            evidence: {
              sourceDigestReverified: true, nativeFreshDocumentCopy: true,
              nativeContentSnapshotMatched: true, nativeMetadataAbsent: true,
              popplerMetadataAbsent: true, popplerCustomMetadataAbsent: true,
              outputUnsigned: true, allPagesRendered: true, artifactDigestBound: true,
              sourceUnchanged: true,
            },
            limitations: ['Metadata-only bounded profile.'],
          };
        },
      },
      readArtifact: async (requestedArtifact) => {
        assert.equal(requestedArtifact, promoted);
        return output;
      },
    },
  };
}

function hiddenDataSourcePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Metadata /Length 0 >>\nstream\n\nendstream',
  ];
  let body = '%PDF-1.7\n';
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function hiddenDataContext() {
  const sourcePdf = hiddenDataSourcePdf();
  const sourceSha256 = digest(sourcePdf);
  const built = buildPdfHiddenDataSanitization(sourcePdf, {
    profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE,
    sourceSha256,
  });
  const promoted = artifact('pdf-hidden-data-sanitization', sourceSha256, built.bytes);
  const calls = [];
  return {
    sourcePdf, sourceSha256, built, promoted, calls,
    context: {
      documentId, sourcePdf, sourceSha256,
      hiddenDataSanitization: {
        async sanitize(requestedDocumentId, options) {
          calls.push({ requestedDocumentId, options });
          return { artifact: promoted, proof: built.proof, limitations: built.proof.limitations };
        },
      },
      readArtifact: async (requestedArtifact) => {
        assert.equal(requestedArtifact, promoted);
        return built.bytes;
      },
    },
  };
}

test('metadata professional boundary returns only the source-bound reread production artifact', async () => {
  const fixture = metadataContext();
  const result = await opSanitizeMetadata(fixture.context);
  assert.equal(result.method, 'production-pdfkit-metadata-sanitization-service');
  assert.equal(result.pdf, fixture.output);
  assert.equal(result.outputSha256, digest(fixture.output));
  assert.equal(result.sourceSha256, fixture.sourceSha256);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.titleRemoved, true);
  assert.deepEqual(fixture.calls, [{
    requestedDocumentId: documentId,
    options: { sourceSha256: fixture.sourceSha256, signal: undefined },
  }]);
  assert.equal(result.pdf.includes(Buffer.from('SOURCE-CONTENT-MUST-BE-PRESERVED')), true);
  assert.equal(result.pdf.includes(Buffer.from('METADATA_SANITIZED')), false);
});

test('metadata professional boundary rejects missing authority, stale source, forged receipt, and changed readback', async () => {
  const fixture = metadataContext();
  await assert.rejects(opSanitizeMetadata({
    documentId, sourcePdf: fixture.sourcePdf, sourceSha256: fixture.sourceSha256,
  }), { code: 'PDFKIT_SANITIZATION_UNAVAILABLE', status: 503 });
  await assert.rejects(opSanitizeMetadata({ ...fixture.context, sourceSha256: '0'.repeat(64) }), {
    code: 'SOURCE_VERSION_MISMATCH', status: 409,
  });

  const forged = metadataContext();
  forged.context.pdfkitSanitization.sanitizeMetadata = async () => ({
    kind: 'pdfkit-metadata-sanitization', sourceDigest: forged.sourceSha256,
    artifact: forged.promoted, sanitization: { profile: PDFKIT_METADATA_SANITIZATION_PROFILE, removedCategories: ['document-info'] },
    evidence: { sourceDigestReverified: true }, limitations: [],
  });
  await assert.rejects(opSanitizeMetadata(forged.context), { code: 'PDFKIT_SANITIZATION_RECEIPT_INVALID' });

  const changed = metadataContext();
  changed.context.readArtifact = async () => Buffer.concat([changed.output, Buffer.from('tampered')]);
  await assert.rejects(opSanitizeMetadata(changed.context), { code: 'PDFKIT_SANITIZATION_RECEIPT_INVALID' });
});

test('hidden-data professional boundary independently reinspects the reread production artifact', async () => {
  const fixture = hiddenDataContext();
  const result = await opSanitizeHiddenData(fixture.context);
  assert.equal(result.method, 'production-hidden-data-sanitization-service');
  assert.equal(result.pdf, fixture.built.bytes);
  assert.equal(result.outputSha256, fixture.built.proof.outputSha256);
  assert.equal(result.proof.orphanResidueAbsent, true);
  assert.equal(result.proof.priorRevisionResidueAbsent, true);
  assert.equal(result.proof.reachablePageContentPreserved, true);
  assert.deepEqual(fixture.calls, [{
    requestedDocumentId: documentId,
    options: { sourceSha256: fixture.sourceSha256, signal: undefined },
  }]);
});

test('hidden-data professional boundary propagates stable service failure and rejects tampered output', async () => {
  const fixture = hiddenDataContext();
  const unavailable = { ...fixture.context, hiddenDataSanitization: undefined };
  await assert.rejects(opSanitizeHiddenData(unavailable), {
    code: 'HIDDEN_DATA_SANITIZATION_UNAVAILABLE', status: 503,
  });

  const serviceFailure = new Error('private sanitizer detail');
  serviceFailure.code = 'HIDDEN_DATA_SANITIZATION_SOURCE_UNSUPPORTED';
  fixture.context.hiddenDataSanitization.sanitize = async () => { throw serviceFailure; };
  await assert.rejects(opSanitizeHiddenData(fixture.context), {
    code: 'HIDDEN_DATA_SANITIZATION_SOURCE_UNSUPPORTED',
  });

  const tampered = hiddenDataContext();
  const changedBytes = Buffer.concat([tampered.built.bytes, Buffer.from('tampered')]);
  tampered.promoted.size = changedBytes.length;
  tampered.promoted.sha256 = digest(changedBytes);
  tampered.promoted.operation.validation.outputSha256 = tampered.promoted.sha256;
  tampered.context.readArtifact = async () => changedBytes;
  await assert.rejects(opSanitizeHiddenData(tampered.context), {
    code: 'HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID',
  });
});
