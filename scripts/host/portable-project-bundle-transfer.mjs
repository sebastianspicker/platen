import { lstat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { cleanDisplayName, DEFAULT_MAX_PDF_BYTES } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import {
  assertPortableProjectNotAborted,
  canonicalizeProjectBundle,
  createPortableProjectManifest,
  createPortableProjectPrefix,
  createPortableProjectReader,
  freezeProjectBundle,
  isProjectBundleDigest,
  parsePortableProjectManifest,
  portableProjectHeaderBytes,
  portableProjectMagic,
  PORTABLE_PROJECT_BUNDLE_EXTENSION,
  PORTABLE_PROJECT_BUNDLE_MAX_BYTES,
  PORTABLE_PROJECT_BUNDLE_MAX_MANIFEST_BYTES,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  snapshotProjectWorkspace,
} from './project-bundle-framing.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export class PortableProjectBundleTransfer {
  #documents; #workspace; #validateDocument;
  constructor(documents, workspace, validateDocument) { this.#documents = documents; this.#workspace = workspace; this.#validateDocument = validateDocument; }

  async exportPortableBundle(documentId) {
    if (!['verifySource', 'getSourcePath'].every((name) => typeof this.#documents[name] === 'function')) fail('PORTABLE_PROJECT_UNAVAILABLE', 'The document store cannot create portable project bundles.', 503);
    const document = this.#documents.getDocument(documentId);
    if (!Number.isSafeInteger(document.size) || document.size < 1 || document.size > DEFAULT_MAX_PDF_BYTES || !isProjectBundleDigest(document.sha256)) fail('PROJECT_BUNDLE_DOCUMENT_INVALID', 'The local document does not have valid portable source metadata.', 500);
    await this.#documents.verifySource(documentId);
    const sourcePath = this.#documents.getSourcePath(documentId);
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== document.size) fail('SOURCE_INTEGRITY_FAILED', 'The immutable source PDF is not a safe portable bundle input.', 500);
    const source = { displayName: cleanDisplayName(document.displayName), mediaType: 'application/pdf', size: document.size, sha256: document.sha256 };
    const manifest = createPortableProjectManifest(source, snapshotProjectWorkspace(this.#workspace.exportSnapshot(documentId)));
    const prefix = createPortableProjectPrefix(manifest);
    const size = prefix.length + document.size;
    if (!Number.isSafeInteger(size) || size > PORTABLE_PROJECT_BUNDLE_MAX_BYTES) fail('PROJECT_BUNDLE_TOO_LARGE', 'Portable project exceeds the local size limit.', 413);
    const stem = basename(source.displayName, extname(source.displayName));
    return Object.freeze({ displayName: `${stem}${PORTABLE_PROJECT_BUNDLE_EXTENSION}`, mediaType: PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE, size, prefix, sourcePath, sourceSha256: source.sha256, manifest: freezeProjectBundle(manifest) });
  }

  async importPortableBundle(stream, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (!['createDocument', 'deleteDocument'].every((name) => typeof this.#documents[name] === 'function')) fail('PORTABLE_PROJECT_UNAVAILABLE', 'The document store cannot import portable project bundles.', 503);
    const reader = createPortableProjectReader(stream, signal);
    const header = await reader.readExact(portableProjectHeaderBytes());
    const magic = portableProjectMagic();
    if (!header.subarray(0, magic.length).equals(magic)) fail('PORTABLE_PROJECT_INVALID_MAGIC', 'The selected file is not a Platen portable project.');
    const manifestLength = header.readUInt32BE(magic.length);
    if (manifestLength < 1 || manifestLength > PORTABLE_PROJECT_BUNDLE_MAX_MANIFEST_BYTES) fail('PORTABLE_PROJECT_MANIFEST_TOO_LARGE', 'Portable project manifest exceeds the local size limit.', 413);
    const manifest = parsePortableProjectManifest(await reader.readExact(manifestLength));
    assertPortableProjectNotAborted(signal);
    let document = null;
    try {
      document = await this.#documents.createDocument({ stream: reader.pdfStream(manifest.source.size), displayName: manifest.source.displayName, mediaType: 'application/pdf' });
      if (document.size !== manifest.source.size || document.sha256 !== manifest.source.sha256) fail('PORTABLE_PROJECT_SOURCE_MISMATCH', 'Embedded PDF does not match the portable project manifest.', 409);
      if (this.#validateDocument) await this.#validateDocument(document.id, { signal });
      const workspace = this.#workspace.replaceSnapshot(document.id, { documentId: document.id, revision: manifest.workspace.revision, namespaces: manifest.workspace.namespaces, audit: manifest.workspace.audit }, { expectedRevision: 0 });
      return freezeProjectBundle({ kind: 'portable-project-import', document, workspace, sourceDigest: document.sha256, manifestDigest: manifest.payloadSha256 });
    } catch (error) {
      if (document) { this.#workspace.deleteDocument(document.id); await this.#documents.deleteDocument(document.id).catch(() => {}); }
      throw error;
    }
  }
}
