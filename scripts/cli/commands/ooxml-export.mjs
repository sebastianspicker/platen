import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OoxmlCleanupError } from '../../host/pdf-ooxml-export.mjs';

const EXPECTED = Object.freeze({
  word: Object.freeze({ extension: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  excel: Object.freeze({ extension: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  powerpoint: Object.freeze({ extension: 'pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
});

function invalid(message) { const error = new Error(message); error.code = 'CLI_OOXML_ARTIFACT_INVALID'; throw error; }
function validateArtifact(result, stored, document, format, bytes) {
  const expected = EXPECTED[format];
  if (!expected || !result?.artifact || !stored || stored.id !== result.artifact.id || stored.documentId !== document.id || result.artifact.documentId !== document.id || result.artifact.mediaType !== expected.mediaType || result.artifact.size !== bytes.length
    || result.sourceDigest !== document.sha256 || stored.sha256 !== result.artifact.sha256 || stored.mediaType !== expected.mediaType
    || !stored.displayName.toLowerCase().endsWith(`.${expected.extension}`) || stored.extension && stored.extension !== expected.extension
    || stored.size !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== stored.sha256) invalid('The OOXML artifact failed exact source, format, size, or digest validation.');
}

export async function runOoxmlExportCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal); if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  let result = null; let artifactId = null;
  try {
    result = await application.ooxmlExport.export(document.id, command.format, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const candidateId = result?.artifact?.id ?? null;
    const stored = application.store.getArtifact(candidateId);
    const bytes = await readFile(stored.filePath);
    validateArtifact(result, stored, document, command.format, bytes);
    artifactId = stored.id;
    await runtime.copyExclusive(stored.filePath, command.output, signal);
    runtime.cancelled(signal);
    await application.store.deleteArtifact(artifactId);
    artifactId = null;
    await runtime.emit(stdout, {
      kind: 'pdf-ooxml-export', format: command.format, output: basename(command.output),
      extension: result.extension, pageCount: result.pageCount, size: stored.size,
      sha256: stored.sha256, sourceDigest: result.sourceDigest,
      validation: { passed: true, textOnly: true, localOnly: true }, limitations: result.limitations,
    });
  } catch (error) {
    if (artifactId) {
      try { await application.store.deleteArtifact(artifactId); }
      catch (cleanupError) { throw new OoxmlCleanupError([error, cleanupError], 'OOXML artifact cleanup failed.'); }
    }
    throw error;
  }
}
