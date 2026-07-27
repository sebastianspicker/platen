import { createHash } from 'node:crypto';

export const LOCAL_SBOM_SCHEMA = 'pdf-local-sbom-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const GROUPS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_SEGMENT = /^(?:\.env(?:\..*)?|.*(?:token|secret|credential|password|private[-_.]?key|auth(?:entication)?|key)(?:[-_.].*)?|.*\.(?:key|pem|p12|pfx))$/iu;
const NODE_ENGINE = /^>=\d+(?:\.\d+(?:\.\d+)?)?(?:\s+<\d+(?:\.\d+(?:\.\d+)?)?)?$/u;

function sbomError(message) { const error = new Error(message); error.code = 'RELEASE_SBOM_INVALID'; return error; }
function exactObject(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function inventoryDigest(files) { const hash = createHash('sha256'); for (const file of files) hash.update(`${file.path}\0${file.sha256}\0${file.size}\n`, 'utf8'); return hash.digest('hex'); }

function checkedFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 10_000) throw sbomError('SBOM file inventory is outside the bounded local release limit.');
  const checked = files.map((file) => { if (!exactObject(file, ['path', 'sha256', 'size']) || typeof file.path !== 'string' || file.path.length > 1024 || !file.path || file.path.includes('\\') || file.path.split('/').some((segment) => !SAFE_SEGMENT.test(segment) || SECRET_SEGMENT.test(segment)) || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw sbomError('SBOM file inventory contains an invalid record.'); return { path: file.path, sha256: file.sha256, size: file.size }; });
  const sorted = [...checked].sort((left, right) => left.path.localeCompare(right.path)); if (sorted.some((file, index) => index > 0 && file.path === sorted[index - 1].path) || sorted.some((file, index) => file.path !== checked[index]?.path)) throw sbomError('SBOM file inventory must be unique and canonically sorted.');
  return sorted;
}

function checkedPackage(packageMetadata) {
  if (!exactObject(packageMetadata, ['name', 'version', 'license', 'private', 'nodeEngine']) || typeof packageMetadata.name !== 'string' || !packageMetadata.name || packageMetadata.name.length > 214 || typeof packageMetadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageMetadata.version) || typeof packageMetadata.license !== 'string' || !/^[A-Za-z0-9.-]{1,128}$/u.test(packageMetadata.license) || typeof packageMetadata.nodeEngine !== 'string' || !NODE_ENGINE.test(packageMetadata.nodeEngine) || typeof packageMetadata.private !== 'boolean') throw sbomError('SBOM package metadata is invalid.');
  return { name: packageMetadata.name, version: packageMetadata.version, license: packageMetadata.license, private: packageMetadata.private, nodeEngine: packageMetadata.nodeEngine };
}

export function createLocalSbom({ files, packageMetadata, dependencyGroups } = {}) {
  const checkedFilesValue = checkedFiles(files);
  const checkedPackageMetadata = checkedPackage(packageMetadata);
  if (!exactObject(dependencyGroups, GROUPS) || GROUPS.some((name) => !Array.isArray(dependencyGroups[name]) || dependencyGroups[name].length !== 0)) throw sbomError('SBOM dependency groups must be explicitly empty.');
  return validateLocalSbom(freeze({ schema: LOCAL_SBOM_SCHEMA, package: checkedPackageMetadata, files: checkedFilesValue, declaredDependencies: Object.fromEntries(GROUPS.map((name) => [name, []])), inventorySha256: inventoryDigest(checkedFilesValue) }));
}

export function validateLocalSbom(value) {
  if (!exactObject(value, ['schema', 'package', 'files', 'declaredDependencies', 'inventorySha256']) || value.schema !== LOCAL_SBOM_SCHEMA || !exactObject(value.declaredDependencies, GROUPS) || GROUPS.some((name) => !Array.isArray(value.declaredDependencies[name]) || value.declaredDependencies[name].length !== 0) || !SHA256.test(value.inventorySha256)) throw sbomError('SBOM document shape is invalid.');
  checkedPackage(value.package);
  const files = checkedFiles(value.files); if (files.some((file, index) => file.path !== value.files[index].path || file.sha256 !== value.files[index].sha256 || file.size !== value.files[index].size) || inventoryDigest(files) !== value.inventorySha256) throw sbomError('SBOM inventory digest or ordering is invalid.');
  return freeze(value);
}

export { inventoryDigest };
