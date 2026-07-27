import { HostError } from './host-error.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export async function resolvePinnedDependencyDag(root, loadPackage) {
  const visiting = new Set(); const resolved = new Set(); const dependencies = [];
  async function visit(request, isRoot = false) {
    const key = `${request.id}@${request.version}#${request.digest}`;
    if (visiting.has(key)) fail('PACKAGE_DEPENDENCY_CYCLE', 'Plugin dependency graph contains a cycle.', 409);
    if (resolved.has(key)) return;
    const loaded = await loadPackage(request);
    if (!loaded) fail('PACKAGE_DEPENDENCY_MISSING', 'A pinned plugin dependency is not installed.', 424);
    if (loaded.digest !== request.digest || loaded.manifest?.id !== request.id || loaded.manifest?.version !== request.version) fail('PACKAGE_DEPENDENCY_MISMATCH', 'Installed dependency does not match its signed identity pin.', 409);
    visiting.add(key);
    for (const dependency of loaded.manifest.dependencies) await visit(dependency);
    visiting.delete(key); resolved.add(key);
    if (!isRoot) dependencies.push(Object.freeze({ id: request.id, version: request.version, digest: request.digest }));
  }
  await visit(root, true);
  return Object.freeze(dependencies);
}
