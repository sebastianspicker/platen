import { HostError } from './host-error.mjs';
import {
  canonicalizeProjectBundle,
  createProjectBundle,
  freezeProjectBundle,
  isProjectBundleDigest,
  parseProjectBundle,
  PROJECT_BUNDLE_MAX_BYTES,
  snapshotProjectWorkspace,
} from './project-bundle-framing.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export class ProjectBundleWorkspaceTransfer {
  #documents; #workspace;

  constructor(documents, workspace) { this.#documents = documents; this.#workspace = workspace; }

  exportBundle(documentId) {
    const document = this.#documents.getDocument(documentId);
    if (!isProjectBundleDigest(document?.sha256)) fail('PROJECT_BUNDLE_DOCUMENT_INVALID', 'The local document does not have a valid source digest.', 500);
    const workspace = snapshotProjectWorkspace(this.#workspace.exportSnapshot(documentId));
    const serialized = canonicalizeProjectBundle(createProjectBundle(document.sha256, workspace));
    if (Buffer.byteLength(serialized, 'utf8') > PROJECT_BUNDLE_MAX_BYTES) fail('PROJECT_BUNDLE_TOO_LARGE', 'Project bundle exceeds the local size limit.', 413);
    return serialized;
  }

  importBundle(documentId, input, { expectedRevision } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('PROJECT_BUNDLE_REVISION_REQUIRED', 'Project bundle import requires the current non-negative workspace revision.');
    const bundle = parseProjectBundle(input);
    const document = this.#documents.getDocument(documentId);
    if (!isProjectBundleDigest(document?.sha256)) fail('PROJECT_BUNDLE_DOCUMENT_INVALID', 'The local document does not have a valid source digest.', 500);
    if (document.sha256 !== bundle.sourcePdfSha256) fail('PROJECT_BUNDLE_SOURCE_MISMATCH', 'Project bundle belongs to a different source PDF.', 409);
    return freezeProjectBundle(this.#workspace.replaceSnapshot(documentId, {
      documentId, revision: bundle.workspace.revision, namespaces: bundle.workspace.namespaces, audit: bundle.workspace.audit,
    }, { expectedRevision }));
  }
}
