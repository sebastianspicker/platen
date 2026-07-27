import assert from 'node:assert/strict'; import test from 'node:test'; import { createLocalSbom, validateLocalSbom } from '../scripts/release/local-sbom.mjs';
const files = [{ path: 'README.md', sha256: 'b'.repeat(64), size: 2 }, { path: 'package.json', sha256: 'a'.repeat(64), size: 1 }]; const pkg = { name: 'fixture', version: '1.2.3', license: 'MIT', private: true, nodeEngine: '>=20' }; const deps = { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] };
test('local SBOM is deterministic, sorted, deeply frozen, and explicitly dependency-free', () => {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const first = createLocalSbom({ files: ordered, packageMetadata: pkg, dependencyGroups: deps });
  const second = createLocalSbom({ files: ordered, packageMetadata: pkg, dependencyGroups: deps });
  assert.deepEqual(first, second); assert.equal(first.schema, 'pdf-local-sbom-v1');
  assert.deepEqual(first.files.map((file) => file.path), ['package.json', 'README.md']);
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.files[0]), true);
  assert.throws(() => { first.files[0].size = 99; }, TypeError);
});
test('local SBOM rejects tampered digest, package semantics, unsafe paths, unsorted inventory, and declared dependency groups', () => {
  assert.throws(() => createLocalSbom({ files, packageMetadata: pkg, dependencyGroups: { ...deps, dependencies: ['x'] } }), { code: 'RELEASE_SBOM_INVALID' });
  const sbom = createLocalSbom({ files: [...files].sort((a, b) => a.path.localeCompare(b.path)), packageMetadata: pkg, dependencyGroups: deps });
  assert.throws(() => validateLocalSbom({ ...sbom, inventorySha256: 'c'.repeat(64) }), { code: 'RELEASE_SBOM_INVALID' });
  assert.throws(() => validateLocalSbom({ ...sbom, package: { ...sbom.package, private: 'true' } }), { code: 'RELEASE_SBOM_INVALID' });
  assert.throws(() => validateLocalSbom({ ...sbom, package: { ...sbom.package, version: 'latest' } }), { code: 'RELEASE_SBOM_INVALID' });
  assert.throws(() => validateLocalSbom({ ...sbom, package: { ...sbom.package, nodeEngine: '*' } }), { code: 'RELEASE_SBOM_INVALID' });
  assert.throws(() => validateLocalSbom({ ...sbom, files: sbom.files.map((file) => ({ ...file, path: '.env' })) }), { code: 'RELEASE_SBOM_INVALID' });
  assert.throws(() => validateLocalSbom({ ...sbom, files: [...sbom.files].reverse() }), { code: 'RELEASE_SBOM_INVALID' });
});
