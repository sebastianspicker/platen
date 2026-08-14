import { resolve } from 'node:path';
import { HostError } from './host-error.mjs';
import { cleanDisplayName, containsPdfHeader } from './document-store-contract.mjs';
import { createDocument, getDocument, getSourcePath, verifySource } from './document-store-documents.mjs';
import { cleanupJob, createJobWorkspace, disposeStore, initializeStore } from './document-store-jobs.mjs';
import { claimArtifactForTransfer, deleteArtifact, deleteDocument, getArtifact, promoteOoxmlArtifact, promotePdfArtifact } from './document-store-artifacts.mjs';
import { promoteComparisonPackageArtifact } from './document-store-comparison-artifact.mjs';
import { digestFile } from './document-store-file-io.mjs';

export const DEFAULT_MAX_PDF_BYTES = 512 * 1024 * 1024;

export class DocumentStore {
  #state;

  constructor({ root, maxBytes = DEFAULT_MAX_PDF_BYTES }) {
    if (!root) throw new TypeError('DocumentStore requires a private session root.');
    this.#state = { root: resolve(root), maxBytes, documents: new Map(), artifacts: new Map(), disposed: false };
  }

  get root() { return this.#state.root; }

  async initialize() {
    await initializeStore(this.#state);
    return this;
  }

  createDocument(input) { return createDocument(this.#state, input); }
  getDocument(id) { return getDocument(this.#state, id); }
  getSourcePath(id) { return getSourcePath(this.#state, id); }
  verifySource(id) { return verifySource(this.#state, id); }
  createJobWorkspace(documentId) { return createJobWorkspace(this.#state, documentId); }
  cleanupJob(directory) { return cleanupJob(this.#state, directory); }
  promotePdfArtifact(documentId, sourcePath, options) { return promotePdfArtifact(this.#state, documentId, sourcePath, options); }
  promoteOoxmlArtifact(documentId, sourcePath, options) { return promoteOoxmlArtifact(this.#state, documentId, sourcePath, options); }
  promoteComparisonPackageArtifact(primaryDocumentId, revisionDocumentId, sourcePath, options) { return promoteComparisonPackageArtifact(this.#state, primaryDocumentId, revisionDocumentId, sourcePath, options); }
  getArtifact(id) { return getArtifact(this.#state, id); }
  claimArtifactForTransfer(id) { return claimArtifactForTransfer(this.#state, id); }
  deleteArtifact(id) { return deleteArtifact(this.#state, id); }
  deleteDocument(id) { return deleteDocument(this.#state, id); }
  dispose() { return disposeStore(this.#state); }
}

export { cleanDisplayName, containsPdfHeader, digestFile };
