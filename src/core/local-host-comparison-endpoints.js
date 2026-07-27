import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

/** Document-pair and bounded batch-comparison transport. */
export function createComparisonEndpoints({ json }) {
  return {
    compareDocuments(
      documentId,
      secondaryDocumentId,
      mode,
      options = {},
      { signal } = {},
    ) {
      return postJson(
        json,
        documentEndpointPath(documentId, '/compare'),
        { secondaryDocumentId, mode, options },
        signal,
      ).then((body) => body.report);
    },
    compareBatch(pairs, mode = 'content', { signal } = {}) {
      return postJson(
        json,
        '/api/comparisons/batch',
        { pairs, mode },
        signal,
      ).then((body) => body.report);
    },
  };
}
