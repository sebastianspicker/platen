import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_CAPABILITY_COUNT = 318;
export const CAPABILITY_PROOF_PATH = 'catalog/capability-proofs/proofs.json';
export const CAPABILITY_PROOF_SCHEMA_PATH = 'contracts/capability-proof.schema.json';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ID_PATTERN = /^[a-z][a-z0-9-]*(?:[.][a-z][a-z0-9-]*)+$/;
const STATUS_VALUES = new Set(['proven', 'partial', 'false', 'unaudited']);
const SURFACE_KINDS = new Set(['entrypoint', 'route', 'command', 'ui', 'none']);
const ASSESSMENTS = new Set(['verified', 'partial', 'absent', 'not-applicable', 'not-audited']);
const DIMENSIONS = ['sourceBinding', 'failureEvidence', 'trustBoundary', 'independentValidation'];
const RECORD_KEYS = [
  'audited', 'capabilityId', 'evidenceRefs', 'failureEvidence', 'independentValidation',
  'rationale', 'shippedSurface', 'sourceBinding', 'status', 'trustBoundary',
];

function fail(message) {
  throw new Error(`Capability proof verification failed: ${message}`);
}

function readJson(root, repositoryPath) {
  const absolutePath = resolve(root, repositoryPath);
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`${repositoryPath} is not valid JSON: ${error.message}`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly ${wanted.join(', ')}`);
  }
}

function assertUniqueStrings(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  if (!allowEmpty && values.length === 0) fail(`${label} must not be empty`);
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
    fail(`${label} must contain non-empty strings`);
  }
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
}

function assertRepositoryFile(root, repositoryPath, label) {
  if (typeof repositoryPath !== 'string' || repositoryPath.length === 0) fail(`${label} must be a repository-relative path`);
  if (isAbsolute(repositoryPath) || repositoryPath.split(/[\\/]/u).includes('..')) {
    fail(`${label} must stay inside the repository`);
  }
  const absolutePath = resolve(root, repositoryPath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolutePath.startsWith(rootPrefix)) fail(`${label} must stay inside the repository`);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) fail(`${label} does not name an existing file: ${repositoryPath}`);
  return repositoryPath;
}

function validateAssessment(record, dimension, aggregateRefs) {
  const value = record[dimension];
  assertExactKeys(value, ['assessment', 'evidenceRefs'], `${record.capabilityId}.${dimension}`);
  if (!ASSESSMENTS.has(value.assessment)) fail(`${record.capabilityId}.${dimension}.assessment is invalid`);
  assertUniqueStrings(value.evidenceRefs, `${record.capabilityId}.${dimension}.evidenceRefs`, { allowEmpty: true });
  for (const evidenceRef of value.evidenceRefs) {
    if (!aggregateRefs.has(evidenceRef)) fail(`${record.capabilityId}.${dimension} references evidence omitted from evidenceRefs: ${evidenceRef}`);
  }
}

function validateRecord(root, record) {
  assertExactKeys(record, RECORD_KEYS, `proof record ${record?.capabilityId ?? '<unknown>'}`);
  if (!ID_PATTERN.test(record.capabilityId)) fail(`invalid capabilityId: ${record.capabilityId}`);
  if (typeof record.audited !== 'boolean') fail(`${record.capabilityId}.audited must be boolean`);
  if (!STATUS_VALUES.has(record.status)) fail(`${record.capabilityId}.status is invalid`);
  if (typeof record.rationale !== 'string' || !record.rationale.trim()) fail(`${record.capabilityId}.rationale must be non-empty`);

  assertExactKeys(record.shippedSurface, ['kind', 'reference'], `${record.capabilityId}.shippedSurface`);
  if (!SURFACE_KINDS.has(record.shippedSurface.kind)) fail(`${record.capabilityId}.shippedSurface.kind is invalid`);
  assertUniqueStrings(record.evidenceRefs, `${record.capabilityId}.evidenceRefs`, { allowEmpty: true });
  const aggregateRefs = new Set(record.evidenceRefs);

  for (const dimension of DIMENSIONS) validateAssessment(record, dimension, aggregateRefs);

  if (!record.audited) {
    if (record.status !== 'unaudited') fail(`${record.capabilityId} is unaudited and must use status unaudited`);
    if (record.shippedSurface.kind !== 'none' || record.shippedSurface.reference !== null) {
      fail(`${record.capabilityId} is unaudited and must not assert a shipped surface`);
    }
    if (record.evidenceRefs.length !== 0) fail(`${record.capabilityId} is unaudited and must not assert evidence`);
    for (const dimension of DIMENSIONS) {
      if (record[dimension].assessment !== 'not-audited' || record[dimension].evidenceRefs.length !== 0) {
        fail(`${record.capabilityId}.${dimension} must remain not-audited without evidence`);
      }
    }
    return;
  }

  if (record.status === 'unaudited') fail(`${record.capabilityId} is audited and must have a proof status`);
  if (record.shippedSurface.kind === 'none' || record.shippedSurface.reference === null) {
    fail(`${record.capabilityId} is audited and must identify a shipped surface`);
  }
  if (record.evidenceRefs.length < 2) fail(`${record.capabilityId} needs at least two evidence references`);
  if (!aggregateRefs.has(record.shippedSurface.reference)) {
    fail(`${record.capabilityId}.shippedSurface.reference must be included in evidenceRefs`);
  }
  for (const dimension of DIMENSIONS) {
    if (record[dimension].assessment === 'not-audited') fail(`${record.capabilityId}.${dimension} must be assessed`);
    if (record[dimension].evidenceRefs.length === 0) fail(`${record.capabilityId}.${dimension} needs evidence`);
  }

  if (record.status === 'proven') {
    if (record.sourceBinding.assessment !== 'verified') fail(`${record.capabilityId} cannot be proven without verified source binding`);
    if (!['verified', 'not-applicable'].includes(record.failureEvidence.assessment)) {
      fail(`${record.capabilityId} cannot be proven without verified or inapplicable failure evidence`);
    }
    if (record.trustBoundary.assessment !== 'verified') fail(`${record.capabilityId} cannot be proven without a verified trust boundary`);
    if (record.independentValidation.assessment !== 'verified') fail(`${record.capabilityId} cannot be proven without independent validation`);
  }
  if (record.status === 'partial' && !DIMENSIONS.some((dimension) => ['partial', 'absent'].includes(record[dimension].assessment))) {
    fail(`${record.capabilityId} is partial but records no partial or absent proof dimension`);
  }
  if (record.status === 'false' && !DIMENSIONS.some((dimension) => record[dimension].assessment === 'absent')) {
    fail(`${record.capabilityId} is false but records no absent proof dimension`);
  }

  for (const repositoryPath of record.evidenceRefs) {
    assertRepositoryFile(root, repositoryPath, `${record.capabilityId}.evidenceRefs`);
  }
}

export function validateCapabilityProofManifest({ root = DEFAULT_ROOT, catalog, manifest }) {
  if (!Array.isArray(catalog)) fail('catalog/capabilities.json must be an array');
  if (catalog.length !== EXPECTED_CAPABILITY_COUNT) {
    fail(`catalog must contain exactly ${EXPECTED_CAPABILITY_COUNT} capabilities, found ${catalog.length}`);
  }
  const catalogIds = catalog.map(({ id }) => id);
  if (catalogIds.some((id) => !ID_PATTERN.test(id))) fail('catalog contains an invalid capability ID');
  if (new Set(catalogIds).size !== catalogIds.length) fail('catalog contains duplicate capability IDs');

  assertExactKeys(manifest, ['records', 'schemaVersion'], 'proof manifest');
  if (manifest.schemaVersion !== 1) fail('proof manifest schemaVersion must be 1');
  if (!Array.isArray(manifest.records)) fail('proof manifest records must be an array');
  if (manifest.records.length !== EXPECTED_CAPABILITY_COUNT) {
    fail(`proof manifest must contain exactly ${EXPECTED_CAPABILITY_COUNT} records, found ${manifest.records.length}`);
  }

  const proofIds = manifest.records.map(({ capabilityId }) => capabilityId);
  if (new Set(proofIds).size !== proofIds.length) fail('proof manifest contains duplicate capability IDs');
  const sortedProofIds = [...proofIds].sort();
  if (proofIds.some((id, index) => id !== sortedProofIds[index])) fail('proof records must be sorted by capabilityId');
  const sortedCatalogIds = [...catalogIds].sort();
  const missing = sortedCatalogIds.filter((id) => !proofIds.includes(id));
  const extra = sortedProofIds.filter((id) => !catalogIds.includes(id));
  if (missing.length || extra.length) fail(`proof manifest does not close over catalog IDs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);

  for (const record of manifest.records) validateRecord(root, record);

  const counts = { proven: 0, partial: 0, false: 0, unaudited: 0 };
  for (const { status } of manifest.records) counts[status] += 1;
  return Object.freeze({
    total: manifest.records.length,
    audited: manifest.records.filter(({ audited }) => audited).length,
    ...counts,
  });
}

export function verifyCapabilityProofs(root = DEFAULT_ROOT) {
  const schema = readJson(root, CAPABILITY_PROOF_SCHEMA_PATH);
  if (schema.$id !== 'https://pdf.local/contracts/capability-proof.schema.json' || schema.properties?.schemaVersion?.const !== 1) {
    fail(`${CAPABILITY_PROOF_SCHEMA_PATH} is not the expected versioned contract`);
  }
  const catalog = readJson(root, 'catalog/capabilities.json');
  const manifest = readJson(root, CAPABILITY_PROOF_PATH);
  return validateCapabilityProofManifest({ root, catalog, manifest });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const summary = verifyCapabilityProofs();
    console.log(`Verified capability proofs: ${summary.total} total, ${summary.audited} audited (${summary.proven} proven, ${summary.partial} partial, ${summary.false} false), ${summary.unaudited} unaudited.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
