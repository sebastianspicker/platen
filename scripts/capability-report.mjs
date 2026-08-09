import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const families = readJson('catalog/families.json');
const capabilities = readJson('catalog/capabilities.json');
const prototypeCoverage = readJson('catalog/prototype-coverage.json');
const proofManifest = readJson('catalog/capability-proofs/proofs.json');
const skeletons = ['ocr', 'signing', 'redaction', 'accessibility-remediation', 'ai', 'aec', 'prepress'].map((slug) => ({
  slug,
  manifest: readJson(`plugins/skeletons/${slug}/plugin.template.json`),
}));
const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
const coverageById = new Map(prototypeCoverage.records.map((record) => [record.id, record]));
const proofById = new Map(proofManifest.records.map((record) => [record.capabilityId, record]));
const claimedBySkeleton = new Set(skeletons.flatMap(({ manifest }) => manifest.capabilityIds));
const implemented = capabilities.filter(({ delivery }) => delivery === 'implemented');
const missing = capabilities.filter(({ delivery }) => delivery === 'planned');
const missingInSkeletons = missing.filter(({ id }) => claimedBySkeleton.has(id));
const outsideSkeletons = missing.filter(({ id }) => !claimedBySkeleton.has(id));
const proofCounts = Object.fromEntries(['proven', 'partial', 'false', 'unaudited'].map((status) => [
  status,
  proofManifest.records.filter((record) => record.status === status).length,
]));
if (proofManifest.records.length !== capabilities.length || capabilities.some(({ id }) => !proofById.has(id))) {
  throw new Error('Capability proof manifest must close over the capability catalog before generating the report.');
}
const tiers = ['exact-alpha', 'executable-subset', 'sidecar', 'service-only', 'descriptor', 'proposal', 'blocked', 'excluded'];
const tierTitle = {
  'exact-alpha': 'Exact alpha behavior',
  'executable-subset': 'Executable subset',
  sidecar: 'Local sidecar state',
  'service-only': 'Local service only',
  descriptor: 'Descriptor only',
  proposal: 'Proposal only',
  blocked: 'Blocked',
  excluded: 'Excluded by policy',
};
const tierRecords = Object.fromEntries(tiers.map((tier) => [tier, prototypeCoverage.records.filter((record) => record.tier === tier)]));

const lines = [
  '# Generated feature-gap report',
  '',
  '> Generated from the machine-readable catalog by `npm run report`. Do not edit counts by hand.',
  '',
  `- Normalized capability records: ${capabilities.length}`,
  `- Professional delivery: ${implemented.length} implemented, ${missing.length} planned`,
  `- Proof audit: ${proofCounts.proven} proven, ${proofCounts.partial} audited executable/limited partials, ${proofCounts.false} false/unavailable broad claims, ${proofCounts.unaudited} unaudited`,
  `- Prototype coverage records: ${prototypeCoverage.records.length}`,
  `- Planned records assigned to the seven requested skeletons: ${missingInSkeletons.length}`,
  `- Planned records assigned to core or other future packs: ${outsideSkeletons.length}`,
  '',
  'Professional delivery is the catalog claim. Prototype tier is a separate, deliberately narrower statement of what the local prototype can presently do. Planned records may have a narrower prototype subset, but that is not a professional implementation. No unaudited capability IDs are present.',
  '',
  '## Professional delivery implemented now',
  '',
  ...implemented.map(({ id, title }) => `- \`${id}\`: ${title}`),
  '',
  '## Prototype coverage by tier',
  '',
];

for (const tier of tiers) {
  const records = tierRecords[tier];
  lines.push(`### ${tierTitle[tier]} (${records.length})`, '');
  for (const { id, delivery } of records) {
    const capability = byId.get(id);
    lines.push(`- \`${id}\`: ${capability?.title ?? 'MISSING CATALOG RECORD'} (professional delivery: ${delivery}; proof: ${proofById.get(id)?.status ?? 'MISSING PROOF RECORD'})`);
  }
  lines.push('');
}

lines.push('## Requested skeleton coverage', '');
for (const { manifest } of skeletons) {
  lines.push(`### ${manifest.title} (${manifest.capabilityIds.length})`, '');
  for (const id of manifest.capabilityIds) {
    const capability = byId.get(id);
    const coverage = coverageById.get(id);
    lines.push(`- \`${id}\`: ${capability?.title ?? 'MISSING CATALOG RECORD'} (${coverage?.tier ?? 'MISSING COVERAGE RECORD'})`);
  }
  lines.push('');
}

lines.push('## Planned outside the seven skeletons', '');
for (const family of families) {
  const entries = outsideSkeletons.filter((capability) => capability.familyId === family.id);
  if (!entries.length) continue;
  lines.push(`### ${family.title} (${entries.length})`, '');
  for (const { id, title } of entries) lines.push(`- \`${id}\`: ${title} (${coverageById.get(id)?.tier ?? 'MISSING COVERAGE RECORD'})`);
  lines.push('');
}

const output = `${lines.join('\n').trimEnd()}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(join(root, 'docs/feature-gap-report.md'), output);
  process.stdout.write('Updated docs/feature-gap-report.md from the capability catalog and prototype coverage ledger.\n');
} else {
  process.stdout.write(output);
}
