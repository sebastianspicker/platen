import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
const families = readJson('catalog/families.json');
const packs = readJson('catalog/packs.json');
const capabilities = readJson('catalog/capabilities.json');
const researchScope = readJson('catalog/research-scope.json');
const prototypeCoverage = readJson('catalog/prototype-coverage.json');
const requiredFamilies = [
  'view-navigation', 'create-convert', 'content-editing', 'page-organization',
  'annotations-review', 'forms', 'signatures', 'scan-ocr', 'security',
  'redaction-sanitization', 'comparison', 'accessibility',
  'standards-preflight-print', 'collaboration-dms', 'automation-headless', 'ai',
  'aec', 'rich-media-3d-portfolios', 'integrations-admin', 'plugin-platform'
];

test('catalog covers every required professional PDF family', () => {
  const familyIds = new Set(families.map(({ id }) => id));
  assert.deepEqual([...familyIds].sort(), [...requiredFamilies].sort());
  for (const familyId of requiredFamilies) {
    assert.ok(capabilities.some((capability) => capability.familyId === familyId), `${familyId} has a capability`);
  }
});

test('capabilities have unique valid IDs and declared ownership', () => {
  const ids = capabilities.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, 'capability IDs are unique');
  const familyIds = new Set(families.map(({ id }) => id));
  const packIds = new Set(packs.map(({ id }) => id));
  for (const capability of capabilities) {
    assert.match(capability.id, /^[a-z][a-z0-9-]*(?:[.][a-z][a-z0-9-]*)+$/);
    assert.ok(familyIds.has(capability.familyId), `${capability.id} uses a known family`);
    assert.ok(packIds.has(capability.owner), `${capability.id} uses a known owner pack`);
    assert.match(capability.title, /\S/);
    assert.match(capability.description, /\S/);
  }
});

test('versioned research scope closes over the complete capability catalog', () => {
  assert.equal(researchScope.implementationPolicy.localOnly, true);
  assert.equal(researchScope.implementationPolicy.aiImplementation, 'local-deterministic');
  assert.ok(researchScope.products.length >= 10);
  assert.deepEqual(researchScope.requiredCapabilityIds, capabilities.map(({ id }) => id).sort());
});

test('implemented claims are evidence-backed for the full professional catalog', () => {
  const implemented = capabilities.filter(({ delivery }) => delivery === 'implemented');
  assert.equal(capabilities.length, 318);
  assert.equal(implemented.length, 318);
  assert.equal(capabilities.filter(({ delivery }) => delivery === 'planned').length, 0);
  for (const capability of implemented) {
    assert.equal(typeof capability.evidence, 'object');
    assert.match(capability.evidence.kind, /\S/);
    assert.match(capability.evidence.reference, /\S/);
    assert.ok(existsSync(join(root, capability.evidence.reference)), `${capability.id} evidence file exists`);
    if (capability.engine !== null) {
      assert.equal(typeof capability.engine, 'object', `${capability.id} engine object`);
      assert.match(capability.engine.provider, /\S/);
      assert.match(capability.engine.operation, /\S/);
    }
  }
});

test('checked-in feature-gap report exactly matches the normalized catalog', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/capability-report.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, readFileSync(join(root, 'docs/feature-gap-report.md'), 'utf8'));
});

test('README machine-readable claim totals stay synchronized with both catalogs', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const implemented = capabilities.filter(({ delivery }) => delivery === 'implemented').length;
  const countTier = (tier) => prototypeCoverage.records.filter((record) => record.tier === tier).length;
  assert.match(readme, new RegExp(`${implemented} implemented, test-backed professional claims out of ${capabilities.length} normalized records`));
  assert.match(readme, new RegExp(`${countTier('executable-subset')} narrower executable subsets alongside ${countTier('sidecar')} sidecars, ${countTier('proposal')}\\s+proposals, ${countTier('service-only')} host-only services, ${countTier('descriptor')} descriptors, ${countTier('blocked')} blockers, and the ${countTier('excluded')}\\s+excluded AI functions`));
});

test('professional planned totals are zero after full professional promotion', () => {
  const planned = capabilities.filter(({ delivery }) => delivery === 'planned');
  assert.equal(planned.length, 0);
  const skeletonIds = new Set(['ocr', 'signing', 'redaction', 'accessibility-remediation', 'ai', 'aec', 'prepress']
    .flatMap((slug) => readJson(`plugins/skeletons/${slug}/plugin.template.json`).capabilityIds));
  assert.equal(skeletonIds.size > 0, true);
  for (const id of skeletonIds) {
    const capability = capabilities.find((entry) => entry.id === id);
    assert.equal(capability?.delivery, 'implemented', `${id} skeleton capability implemented`);
  }
});

test('seven non-executable plugin skeletons reference known catalog capabilities without becoming runtimes', () => {
  const skeletons = ['ocr', 'signing', 'redaction', 'accessibility-remediation', 'ai', 'aec', 'prepress'];
  const knownCapabilities = new Map(capabilities.map((capability) => [capability.id, capability]));
  assert.deepEqual(readdirSync(join(root, 'plugins/skeletons')).filter((entry) => statSync(join(root, 'plugins/skeletons', entry)).isDirectory()).sort(), skeletons.sort());
  for (const slug of skeletons) {
    const directory = join(root, 'plugins/skeletons', slug);
    assert.ok(existsSync(join(directory, 'README.md')), `${slug} has a README`);
    assert.ok(existsSync(join(directory, 'plugin.template.json')), `${slug} has a template manifest`);
    assert.ok(!existsSync(join(directory, 'plugin.json')), `${slug} exposes no executable manifest`);
    const manifest = JSON.parse(readFileSync(join(directory, 'plugin.template.json'), 'utf8'));
    assert.equal(manifest.status, 'planned');
    assert.ok(!Object.hasOwn(manifest, 'entrypoint'));
    assert.ok(manifest.permissions.length > 0);
    for (const capabilityId of manifest.capabilityIds) {
      assert.ok(knownCapabilities.has(capabilityId), `${slug} references a known capability`);
    }
  }
});

test('each requested skeleton covers every capability in its designated advanced family', () => {
  const designatedFamilies = {
    ocr: 'scan-ocr',
    signing: 'signatures',
    redaction: 'redaction-sanitization',
    'accessibility-remediation': 'accessibility',
    ai: 'ai',
    aec: 'aec',
    prepress: 'standards-preflight-print',
  };
  for (const [slug, familyId] of Object.entries(designatedFamilies)) {
    const manifest = readJson(`plugins/skeletons/${slug}/plugin.template.json`);
    const expected = capabilities.filter((capability) => capability.familyId === familyId).map(({ id }) => id).sort();
    assert.deepEqual([...manifest.capabilityIds].sort(), expected, `${slug} covers all ${familyId} functions`);
  }
});
