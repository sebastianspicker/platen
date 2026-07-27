import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INTENTIONALLY_UNSHIPPED_MODULES,
  analyzeCurrentSourceReachability,
  findReachableModules,
} from '../scripts/source-module-reachability.mjs';
import { REQUIRED_FILES } from '../scripts/verify-required-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('production entrypoints reach every shipped module or an exact non-executable classification', () => {
  const result = analyzeCurrentSourceReachability(root, REQUIRED_FILES);
  assert.deepEqual(result.unresolvedImports, []);
  assert.deepEqual(result.unexpectedUnreachable, []);
  assert.deepEqual(result.staleUnshipped, []);
  assert.deepEqual(result.missingFromInventory, []);
  for (const path of [
    'src/controllers/aec-workflow-controller.js',
    'src/core/local-host-aec-endpoints.js',
    'scripts/host/aec-artifact-service.mjs',
    'scripts/host/aec-measure-embedding.mjs',
    'scripts/host/pdf-aec-measure-writer.mjs',
    'scripts/host/routes/workspace-routes.mjs',
    'scripts/host/comments-to-office-contract.mjs',
    'scripts/host/comments-to-office-service.mjs',
    'scripts/host/automation/automation-sequence-contract.mjs',
    'scripts/host/automation/automation-sequence-execution.mjs',
    'scripts/host/automation/durable-local-job-policy-migration.mjs',
    'scripts/host/automation/durable-local-job-transactions.mjs',
  ]) assert.equal(result.reachable.includes(path), true, `${path} must remain production-reachable`);
  for (const path of [
    'native/pdfkit-helper/Sources/PDFKitInspector/AecMutation.swift',
    'native/pdfkit-helper/Sources/PDFKitInspector/OutlineBookmarkRemoval.swift',
    'native/plugin-worker/Sources/PluginWorkerCore/DocumentRPC.swift',
  ]) assert.equal(result.nativeSources.includes(path), true, `${path} must remain inventoried`);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reachable), true);
  assert.equal(Object.isFrozen(result.nativeSources), true);
});

test('the intentionally unshipped classification is exact and excludes live modules', () => {
  assert.equal(new Set(INTENTIONALLY_UNSHIPPED_MODULES).size, INTENTIONALLY_UNSHIPPED_MODULES.length);
  assert.equal(INTENTIONALLY_UNSHIPPED_MODULES.every((path) => (
    path.startsWith('scripts/host/plugin-')
    || path.startsWith('src/core/plugin-')
    || ['src/core/permissions.js', 'src/core/validate.js',
      'scripts/host/domains/aec-collaboration.mjs',
      'scripts/host/domains/trust-accessibility.mjs',
      'scripts/host/pdf-page-content-foundation.mjs',
    ].includes(path)
  )), true);
});

test('reachability traversal exposes a disconnected dependency subtree', () => {
  const graph = new Map([
    ['entry', ['controller']],
    ['controller', ['service']],
    ['service', []],
    ['disconnected-writer', ['writer-helper']],
    ['writer-helper', []],
  ]);
  assert.deepEqual([...findReachableModules(graph, ['entry'])].sort(), [
    'controller', 'entry', 'service',
  ]);
});
