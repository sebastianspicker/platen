import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceDocumentTemplate = {
  mediaType: 'application/pdf',
  origin: 'local',
  operation: null,
  createdAt: '2025-01-01T00:00:00.000Z',
};

const operationTemplate = {
  type: 'test',
  inputs: [],
  parameters: {},
  expected: {},
  validation: { passed: true, validators: [] },
  schemaVersion: 1,
  completedAt: '2025-01-01T00:00:00.000Z',
};

const postflightOutputPdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

const hash = (value) => createHash('sha256').update(value).digest('hex');

function makeOperation(operationId) {
  return Object.freeze({ ...operationTemplate, id: operationId });
}

async function createDocumentAndArtifact({ root, sourceId, sourcePdf, artifactId, operationId }) {
  const sourceSha256 = hash(sourcePdf);
  const sourcePath = join(root, 'source.pdf');
  const outputSha256 = hash(postflightOutputPdf);
  const artifactPath = join(root, 'artifact.pdf');
  await writeFile(sourcePath, sourcePdf);
  await writeFile(artifactPath, postflightOutputPdf);

  const artifact = Object.freeze({
    id: artifactId,
    documentId: sourceId,
    displayName: 'derived-document.pdf',
    mediaType: 'application/pdf',
    size: postflightOutputPdf.length,
    sha256: outputSha256,
    filePath: artifactPath,
    operation: makeOperation(operationId),
    createdAt: '2025-01-01T00:00:00.000Z',
  });

  const source = Object.freeze({
    id: sourceId,
    displayName: 'source.pdf',
    mediaType: sourceDocumentTemplate.mediaType,
    size: sourcePdf.length,
    sha256: sourceSha256,
    origin: sourceDocumentTemplate.origin,
    operation: sourceDocumentTemplate.operation,
    createdAt: sourceDocumentTemplate.createdAt,
  });

  return {
    artifact,
    source,
    sourceSha256,
    sourcePath,
    postflightOutputPdf,
  };
}

export { createDocumentAndArtifact, hash };
