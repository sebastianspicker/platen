import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const idPattern = /^[a-z][a-z0-9-]*$/;
const capabilityIdPattern = /^[a-z][a-z0-9-]*(?:[.][a-z][a-z0-9-]*)+$/;

function exactKeys(value, expected, label) {
  assert.equal(value && typeof value, 'object', `${label} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has exactly the schema keys`);
}

function nonemptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} is a string`);
  assert.match(value, /\S/, `${label} is nonempty`);
}

test('family, pack, and capability instances satisfy their strict schema shapes', () => {
  for (const family of readJson('catalog/families.json')) {
    exactKeys(family, ['id', 'title', 'description'], `family ${family.id}`);
    assert.match(family.id, idPattern);
    nonemptyString(family.title, `${family.id}.title`);
    nonemptyString(family.description, `${family.id}.description`);
  }

  for (const pack of readJson('catalog/packs.json')) {
    exactKeys(pack, ['id', 'title', 'description', 'maintainer'], `pack ${pack.id}`);
    assert.match(pack.id, idPattern);
    assert.match(pack.maintainer, idPattern);
    nonemptyString(pack.title, `${pack.id}.title`);
    nonemptyString(pack.description, `${pack.id}.description`);
  }

  for (const capability of readJson('catalog/capabilities.json')) {
    exactKeys(capability, ['id', 'familyId', 'owner', 'delivery', 'title', 'description', 'engine', 'evidence'], `capability ${capability.id}`);
    assert.match(capability.id, capabilityIdPattern);
    assert.match(capability.familyId, idPattern);
    assert.match(capability.owner, idPattern);
    assert.ok(['implemented', 'planned'].includes(capability.delivery));
    nonemptyString(capability.title, `${capability.id}.title`);
    nonemptyString(capability.description, `${capability.id}.description`);
    if (capability.engine !== null) {
      exactKeys(capability.engine, ['provider', 'operation'], `${capability.id}.engine`);
      nonemptyString(capability.engine.provider, `${capability.id}.engine.provider`);
      nonemptyString(capability.engine.operation, `${capability.id}.engine.operation`);
    }
    if (capability.delivery === 'planned') assert.equal(capability.evidence, null);
    else {
      exactKeys(capability.evidence, ['kind', 'reference'], `${capability.id}.evidence`);
      nonemptyString(capability.evidence.kind, `${capability.id}.evidence.kind`);
      nonemptyString(capability.evidence.reference, `${capability.id}.evidence.reference`);
    }
  }
});

test('prototype coverage instances satisfy their strict schema shape and mirror delivery', () => {
  const capabilities = readJson('catalog/capabilities.json');
  const coverage = readJson('catalog/prototype-coverage.json');
  assert.deepEqual(Object.keys(coverage).sort(), ['records', 'schemaVersion']);
  assert.equal(coverage.schemaVersion, 1);
  assert.deepEqual(coverage.records.map(({ id }) => id), capabilities.map(({ id }) => id));
  for (const record of coverage.records) {
    exactKeys(record, ['id', 'delivery', 'tier'], `prototype coverage ${record.id}`);
    assert.match(record.id, capabilityIdPattern);
    assert.ok(['implemented', 'planned'].includes(record.delivery));
    assert.ok(['exact-alpha', 'executable-subset', 'sidecar', 'proposal', 'descriptor', 'service-only', 'blocked', 'excluded'].includes(record.tier));
  }
});

test('research scope instance satisfies its strict local-only schema shape', () => {
  const scope = readJson('catalog/research-scope.json');
  exactKeys(scope, ['schemaVersion', 'snapshotDate', 'methodology', 'implementationPolicy', 'products', 'requiredCapabilityIds'], 'research scope');
  assert.equal(scope.schemaVersion, 1);
  assert.match(scope.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
  nonemptyString(scope.methodology, 'research methodology');
  exactKeys(scope.implementationPolicy, ['localOnly', 'aiImplementation'], 'implementation policy');
  assert.equal(scope.implementationPolicy.localOnly, true);
  assert.ok(['excluded', 'local-deterministic'].includes(scope.implementationPolicy.aiImplementation));
  assert.equal(scope.implementationPolicy.aiImplementation, 'local-deterministic');
  assert.ok(scope.products.length >= 10);
  for (const [index, product] of scope.products.entries()) {
    exactKeys(product, ['name', 'source'], `product ${index}`);
    nonemptyString(product.name, `product ${index}.name`);
    assert.match(product.source, /^https:\/\//);
  }
  assert.equal(new Set(scope.requiredCapabilityIds).size, scope.requiredCapabilityIds.length);
  for (const id of scope.requiredCapabilityIds) assert.match(id, capabilityIdPattern);
});

test('all seven planning manifests satisfy the strict non-executable template shape', () => {
  const directories = readdirSync(join(root, 'plugins/skeletons'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const slug of directories) {
    const manifest = readJson(`plugins/skeletons/${slug}/plugin.template.json`);
    exactKeys(manifest, ['id', 'title', 'version', 'status', 'description', 'permissions', 'dependencies', 'capabilityIds'], `manifest ${slug}`);
    assert.match(manifest.id, idPattern);
    assert.equal(manifest.version, '0.0.0-template');
    assert.equal(manifest.status, 'planned');
    nonemptyString(manifest.title, `${slug}.title`);
    nonemptyString(manifest.description, `${slug}.description`);
    for (const collection of ['permissions', 'dependencies', 'capabilityIds']) {
      assert.ok(Array.isArray(manifest[collection]));
      assert.equal(new Set(manifest[collection]).size, manifest[collection].length, `${slug}.${collection} is unique`);
    }
    assert.ok(manifest.permissions.length > 0);
    assert.ok(manifest.capabilityIds.length > 0);
    for (const capabilityId of manifest.capabilityIds) assert.match(capabilityId, capabilityIdPattern);
  }
});
