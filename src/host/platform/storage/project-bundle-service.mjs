import { PortableProjectBundleTransfer } from './portable-project-bundle-transfer.mjs';
import { ProjectBundleWorkspaceTransfer } from './project-bundle-workspace-transfer.mjs';

export {
  canonicalizeProjectBundle,
  PORTABLE_PROJECT_BUNDLE_EXTENSION,
  PORTABLE_PROJECT_BUNDLE_MAX_BYTES,
  PORTABLE_PROJECT_BUNDLE_MAX_MANIFEST_BYTES,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  PORTABLE_PROJECT_BUNDLE_SCHEMA_VERSION,
  portableProjectMagic,
  PROJECT_BUNDLE_MAX_BYTES,
  PROJECT_BUNDLE_MEDIA_TYPE,
  PROJECT_BUNDLE_SCHEMA_VERSION,
} from './project-bundle-framing.mjs';

/** Local-only, digest-bound serialization of WorkspaceStateStore state. */
export class ProjectBundleService {
  #workspaceTransfer; #portableTransfer;

  constructor(documentStore, workspaceStateStore, { validateDocument = null } = {}) {
    if (!documentStore || typeof documentStore.getDocument !== 'function') throw new TypeError('ProjectBundleService requires a document store.');
    if (!workspaceStateStore || typeof workspaceStateStore.exportSnapshot !== 'function' || typeof workspaceStateStore.replaceSnapshot !== 'function') throw new TypeError('ProjectBundleService requires WorkspaceStateStore.');
    if (validateDocument !== null && typeof validateDocument !== 'function') throw new TypeError('validateDocument must be null or a function.');
    this.#workspaceTransfer = new ProjectBundleWorkspaceTransfer(documentStore, workspaceStateStore);
    this.#portableTransfer = new PortableProjectBundleTransfer(documentStore, workspaceStateStore, validateDocument);
  }

  exportBundle(...args) { return this.#workspaceTransfer.exportBundle(...args); }
  importBundle(...args) { return this.#workspaceTransfer.importBundle(...args); }
  exportPortableBundle(...args) { return this.#portableTransfer.exportPortableBundle(...args); }
  importPortableBundle(...args) { return this.#portableTransfer.importPortableBundle(...args); }
}
