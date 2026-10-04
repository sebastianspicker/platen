import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseArtifactPaths } from './release-artifact-manifest.mjs';
import { verifyCapabilityProofs } from './verify-capability-proofs.mjs';
import { assertCurrentSourceReachability } from '../analysis/source-module-reachability.mjs';
import { prepareNativeTests } from '../native/prepare-native-tests.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const releaseArtifacts = collectReleaseArtifactPaths(root);

for (const path of releaseArtifacts) {
  if (!existsSync(join(root, path))) throw new Error(`Required release artifact is missing: ${path}`);
}

for (const directory of ['catalog', 'schemas']) {
  for (const name of readdirSync(join(root, directory)).filter((entry) => entry.endsWith('.json'))) {
    JSON.parse(readFileSync(join(root, directory, name), 'utf8'));
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
  throw new Error('The dependency-free scaffold must not declare npm dependencies.');
}

const capabilityProofs = verifyCapabilityProofs(root);

const reachability = assertCurrentSourceReachability(root);

prepareNativeTests(root);

console.log(`Verified ${reachability.reachable.length} reachable JavaScript production modules, ${reachability.nativeSources.length} discovered Swift production sources, and ${capabilityProofs.total} capability-proof records (${capabilityProofs.proven} proven, ${capabilityProofs.partial} partial, ${capabilityProofs.false} false, ${capabilityProofs.unaudited} unaudited), plus declared release artifacts, strict JSON catalogs, and zero npm dependencies.`);
