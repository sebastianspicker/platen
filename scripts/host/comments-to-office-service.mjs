import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { buildOoxml, OoxmlCleanupError } from './pdf-ooxml-export.mjs';
import { readZipEntries } from './zip-reader.mjs';
import {
  COMMENTS_TO_OFFICE_PROFILE,
  createCommentsToOfficeEnvelope,
  normalizeCommentsToOfficeRequest,
} from './comments-to-office-contract.mjs';

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_PARTS = Object.freeze(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
const LIMITATIONS = Object.freeze([
  'Text-only DOCX summary; not Word tracked comments or interoperable document review markup.',
  'No source PDF text or bytes, email addresses, HTML, attachments, or annotation geometry are included.',
]);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function abort(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new HostError('JOB_CANCELLED', 'Comments-to-Office export was cancelled.', 499); }

async function verifyCurrentSource(documents, documentId, sourceSha256) {
  await documents.verifySource(documentId);
  if (documents.getDocument(documentId).sha256 !== sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'The source PDF changed during comments export.', 409);
}

function paragraphLines(envelope) {
  const lines = [
    'Comments export',
    `Source revision: ${envelope.revision}`,
    `Comment count: ${envelope.commentCount}`,
    `Comment digest: ${envelope.commentSha256}`,
    'Text-only summary; this is not Word tracked-comments interoperability.',
  ];
  for (const record of envelope.comments) {
    lines.push(`Page ${record.page} | Order ${record.order} | ${record.kind} ${record.id} | Parent ${record.annotationId} | Author ${record.authorId} | Timestamp ${record.timestamp} | Status ${record.status}`);
    lines.push(`Text: ${record.text}`);
  }
  return lines;
}

function validateDocx(bytes, envelope) {
  let entries;
  try { entries = readZipEntries(bytes); } catch (error) { fail('COMMENTS_TO_OFFICE_OUTPUT_INVALID', 'The DOCX failed ZIP validation.', 502, error); }
  if (entries.size !== DOCX_PARTS.length || DOCX_PARTS.some((name) => !entries.has(name))) fail('COMMENTS_TO_OFFICE_OUTPUT_INVALID', 'The DOCX contains unexpected package parts.', 502);
  if ([...entries.keys()].some((name) => /comments|track|html|attach/iu.test(name))) fail('COMMENTS_TO_OFFICE_OUTPUT_INVALID', 'The DOCX contains a forbidden review or attachment part.', 502);
  const xml = entries.get('word/document.xml').toString('utf8');
  if (!xml.includes(envelope.commentSha256) || envelope.comments.some((record) => !xml.includes(`Order ${record.order}`))) fail('COMMENTS_TO_OFFICE_OUTPUT_INVALID', 'The DOCX does not match the trusted comment envelope.', 502);
}

function validateArtifact(artifact, documentId, sha256, size) {
  if (!artifact || artifact.documentId !== documentId || artifact.mediaType !== DOCX_MEDIA_TYPE
    || artifact.sha256 !== sha256 || artifact.size !== size || typeof artifact.displayName !== 'string'
    || !artifact.displayName.endsWith('.docx') || typeof artifact.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(artifact.id)) {
    fail('COMMENTS_TO_OFFICE_OUTPUT_INVALID', 'The promoted comments artifact does not match the validated DOCX.', 502);
  }
}

function provenance(documentId, envelope, outputSha256) {
  return createOperationProvenance({
    type: 'comments-to-office',
    inputs: [{ documentId, sha256: envelope.sourceSha256, role: 'source' }],
    parameters: { profile: COMMENTS_TO_OFFICE_PROFILE, revision: envelope.revision, commentSha256: envelope.commentSha256, commentCount: envelope.commentCount },
    expected: { commentCount: envelope.commentCount, textOnly: true, sourceUnchanged: true, reviewInteroperability: false },
    validation: { passed: true, validators: ['source-sha256', 'workspace-read-lease', 'workspace-revision', 'comment-sha256', 'stored-zip-round-trip', 'docx-text-only-parts', 'artifact-sha256'], outputSha256 },
  });
}

export class CommentsToOfficeService {
  #documents; #workspace;
  constructor({ documents, workspace } = {}) {
    if (!documents || !['getDocument', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promoteOoxmlArtifact'].every((name) => typeof documents[name] === 'function')
      || !workspace || typeof workspace.acquireReadLease !== 'function') throw new TypeError('CommentsToOfficeService requires source-bound document and workspace stores.');
    this.#documents = documents; this.#workspace = workspace;
  }

  async export(documentId, options, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = normalizeCommentsToOfficeRequest(options); abort(signal);
    const source = this.#documents.getDocument(documentId);
    if (source.sha256 !== request.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'The comments export source digest is not current.', 409);
    const lease = this.#workspace.acquireReadLease(documentId, { expectedRevision: request.revision });
    let promoted = null; let completed = false; let workspacePath = null;
    try {
      await verifyCurrentSource(this.#documents, documentId, request.sourceSha256); abort(signal);
      const envelope = createCommentsToOfficeEnvelope(lease.snapshot, request);
      const built = buildOoxml('word', [{ page: 1, text: paragraphLines(envelope).join('\n') }]);
      try {
        validateDocx(built.bytes, envelope); abort(signal);
        workspacePath = await this.#documents.createJobWorkspace(documentId);
        const outputPath = join(workspacePath, 'comments.docx');
        await writeFile(outputPath, built.bytes, { mode: 0o600, flag: 'wx' });
        const outputSha256 = createHash('sha256').update(built.bytes).digest('hex');
        await verifyCurrentSource(this.#documents, documentId, request.sourceSha256); lease.assertCurrent(); abort(signal);
        const displayRoot = basename(source.displayName ?? 'document.pdf', extname(source.displayName ?? 'document.pdf'));
        const candidate = await this.#documents.promoteOoxmlArtifact(documentId, outputPath, { displayName: `${displayRoot}-comments.docx`, mediaType: DOCX_MEDIA_TYPE, extension: 'docx', operation: provenance(documentId, envelope, outputSha256), expectedSha256: outputSha256, signal });
        validateArtifact(candidate, documentId, outputSha256, built.bytes.length); promoted = candidate;
        await verifyCurrentSource(this.#documents, documentId, request.sourceSha256); lease.assertCurrent(); abort(signal); completed = true;
        return Object.freeze({ kind: 'comments-to-office', sourceDigest: envelope.sourceSha256, revision: envelope.revision, commentSha256: envelope.commentSha256, commentCount: envelope.commentCount, artifact: promoted, limitations: LIMITATIONS, localOnly: true });
      } finally { built.bytes.fill(0); }
    } finally {
      lease.release();
      let cleanupError = null; let revocationError = null;
      if (workspacePath) try { await this.#documents.cleanupJob(workspacePath); } catch (error) { cleanupError = error; }
      if (promoted && (!completed || cleanupError) && typeof this.#documents.deleteArtifact === 'function') try { await this.#documents.deleteArtifact(promoted.id); } catch (error) { revocationError = error; }
      if (cleanupError && revocationError) throw new OoxmlCleanupError([cleanupError, revocationError], 'Comments-to-Office cleanup and artifact revocation both failed.');
      if (cleanupError) throw new OoxmlCleanupError([cleanupError], 'Comments-to-Office cleanup failed.');
      if (revocationError) throw new OoxmlCleanupError([revocationError], 'Comments-to-Office artifact revocation failed.');
    }
  }
}
