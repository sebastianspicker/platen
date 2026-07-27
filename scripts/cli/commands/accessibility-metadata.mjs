import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { validateIncrementalAccessibilityMetadataResult } from '../../../src/core/pdf-incremental-accessibility-metadata-contract.js';

function requestDigest(request) {
  return createHash('sha256').update(JSON.stringify({
    language: request.language,
    title: request.title,
  })).digest('hex');
}

export async function runAccessibilityMetadataCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  let result = null;
  let artifactId = null;
  let artifactDeleted = false;
  const request = Object.freeze({ language: command.language, title: command.title });
  try {
    result = await application.incrementalAccessibilityMetadata.update(document.id, request, {
      sourceSha256: document.sha256,
      signal,
    });
    validateIncrementalAccessibilityMetadataResult(result, {
      documentId: document.id,
      sourceSha256: document.sha256,
      request,
      requestSha256: requestDigest(request),
    });
    const candidateArtifactId = result.artifact.id;
    const artifact = application.store.getArtifact(candidateArtifactId);
    const publicArtifact = result.artifact;
    const operationMatches = artifact?.operation?.id === publicArtifact.operation?.id
      && artifact?.operation?.type === publicArtifact.operation?.type;
    if (!artifact
      || artifact.id !== publicArtifact.id
      || artifact.documentId !== publicArtifact.documentId
      || artifact.mediaType !== publicArtifact.mediaType
      || artifact.size !== publicArtifact.size
      || artifact.sha256 !== publicArtifact.sha256
      || !operationMatches
      || typeof artifact.filePath !== 'string'
      || artifact.filePath.length === 0) {
      const error = new Error('The accessibility metadata artifact is unavailable.');
      error.code = 'CLI_ARTIFACT_INVALID';
      throw error;
    }
    artifactId = publicArtifact.id;
    runtime.cancelled(signal);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    await application.store.deleteArtifact(artifactId);
    artifactDeleted = true;
    await runtime.emit(stdout, {
      kind: result.kind,
      sourceDigest: result.sourceDigest,
      metadata: result.metadata,
      artifact: { ...result.artifact, output: basename(command.output) },
      limitations: result.limitations,
      localOnly: true,
      sourceBound: true,
    });
  } catch (error) {
    if (artifactId && !artifactDeleted && typeof application.store.deleteArtifact === 'function') {
      await application.store.deleteArtifact(artifactId).catch(() => {});
    }
    throw error;
  }
}
