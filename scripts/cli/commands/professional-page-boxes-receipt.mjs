import { basename } from 'node:path';

function publicArtifact(artifact, output) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return artifact;
  const {
    id, documentId, displayName, mediaType, size, sha256, createdAt,
  } = artifact;
  return Object.freeze({
    id,
    documentId,
    ...(typeof displayName === 'string' ? { displayName } : {}),
    mediaType,
    size,
    sha256,
    ...(typeof createdAt === 'string' ? { createdAt } : {}),
    output: basename(output),
  });
}

export function sanitizePageBoxesReceipt(result, output) {
  const {
    pdf: _pdf,
    sourcePdf: _sourcePdf,
    sourceSha256: _sourceSha256,
    filePath: _filePath,
    sourcePath: _sourcePath,
    outputPath: _outputPath,
    serviceReceipt,
    ...rest
  } = result;
  let publicServiceReceipt = serviceReceipt;
  if (serviceReceipt && typeof serviceReceipt === 'object' && !Array.isArray(serviceReceipt)) {
    const {
      artifact,
      sourceSha256: _serviceSourceSha256,
      filePath: _serviceFilePath,
      sourcePath: _serviceSourcePath,
      outputPath: _serviceOutputPath,
      ...publicFields
    } = serviceReceipt;
    publicServiceReceipt = Object.freeze({
      ...publicFields,
      artifact: publicArtifact(artifact, output),
    });
  }
  return Object.freeze({
    ...rest,
    serviceReceipt: publicServiceReceipt,
    artifact: publicArtifact(rest.artifact, output),
  });
}

export function sanitizeInsertBlankReceipt(result, output) {
  const {
    pdf: _pdf,
    sourcePdf: _sourcePdf,
    sourceSha256: _sourceSha256,
    blankSourceSha256: _blankSourceSha256,
    operation: _operation,
    serviceReceipt: _serviceReceipt,
    filePath: _filePath,
    sourcePath: _sourcePath,
    outputPath: _outputPath,
    ...rest
  } = result;
  return Object.freeze({
    ...rest,
    artifact: publicArtifact(rest.artifact, output),
  });
}
