// Keep the core JavaScript inventory below the source-layout boundary by
// isolating the complete page-content and text-editing production slice.
export const REQUIRED_JAVASCRIPT_EDITING_FILES = Object.freeze([
  'scripts/host/pdf-content-stream-tokenizer.mjs',
  'scripts/host/pdf-page-content-foundation.mjs',
  'scripts/host/pdf-page-tree-resolver.mjs',
  'scripts/host/pdf-page-vector-contract.mjs',
  'scripts/host/pdf-page-vector-service.mjs',
  'scripts/host/pdf-page-vector-writer.mjs',
  'scripts/host/pdf-page-vector-job.mjs',
  'scripts/host/pdf-page-vector-proof.mjs',
  'scripts/host/pdf-page-text-contract.mjs',
  'scripts/host/pdf-page-text-service.mjs',
  'scripts/host/pdf-page-text-job.mjs',
  'scripts/host/pdf-page-text-writer.mjs',
  'scripts/host/pdf-text-edit-contract.mjs',
  'scripts/host/pdf-text-edit-writer.mjs',
  'scripts/host/pdf-text-edit-service.mjs',
  'scripts/host/pdf-text-reflow-contract.mjs',
  'scripts/host/pdf-text-reflow-writer.mjs',
  'scripts/host/pdf-text-reflow-job.mjs',
  'scripts/host/pdf-text-reflow-service.mjs',
  'scripts/host/pdf-text-reflow.mjs',
]);
