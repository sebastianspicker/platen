import { documentEndpointPath } from './local-host-endpoint-transport.js';

const PROJECT_BUNDLE_MAX_BYTES = 600 * 1024;
const PROJECT_BUNDLE_MEDIA_TYPE = 'application/vnd.platen.project+json';
const PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE = 'application/vnd.platen.portable-project';
const PORTABLE_PROJECT_BUNDLE_MAX_BYTES = 20
  + PROJECT_BUNDLE_MAX_BYTES
  + (512 * 1024 * 1024);

function assertProjectBundle(bundle, expectedRevision) {
  if (typeof bundle !== 'string'
    || new TextEncoder().encode(bundle).byteLength > PROJECT_BUNDLE_MAX_BYTES) {
    throw new TypeError('Project bundle must be UTF-8 JSON within the 600 KiB local limit.');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer.');
  }
}

function assertPortableProjectBundle(bundle) {
  if (!bundle || typeof bundle.size !== 'number' || !Number.isSafeInteger(bundle.size)
    || bundle.size < 1 || bundle.size > PORTABLE_PROJECT_BUNDLE_MAX_BYTES) {
    throw new TypeError('Portable project must be a non-empty bounded Blob.');
  }
}

/** Canonical workspace and self-contained portable-project transport. */
export function createProjectEndpoints({ json, blob, text }) {
  return {
    exportProjectBundle(documentId, { signal } = {}) {
      return text(documentEndpointPath(documentId, '/project-bundle'), { signal });
    },
    importProjectBundle(documentId, bundle, expectedRevision, { signal } = {}) {
      assertProjectBundle(bundle, expectedRevision);
      return json(
        documentEndpointPath(
          documentId,
          `/project-bundle?expectedRevision=${expectedRevision}`,
        ),
        {
          method: 'POST',
          headers: { 'Content-Type': PROJECT_BUNDLE_MEDIA_TYPE },
          body: bundle,
          signal,
        },
      ).then((body) => body.workspace);
    },
    exportPortableProjectBundle(documentId, { signal } = {}) {
      return blob(documentEndpointPath(documentId, '/portable-project-bundle'), { signal });
    },
    importPortableProjectBundle(bundle, { signal } = {}) {
      assertPortableProjectBundle(bundle);
      return json('/api/project-bundles', {
        method: 'POST',
        headers: { 'Content-Type': PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE },
        body: bundle,
        signal,
      }).then((body) => body.result);
    },
  };
}
