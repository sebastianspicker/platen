import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));

const families = readJson('catalog/families.json');
const capabilities = readJson('catalog/capabilities.json');
const prototypeCoverage = readJson('catalog/prototype-coverage.json');
const proofManifest = readJson('catalog/capability-proofs/proofs.json');

const countBy = (records, key) => records.reduce((counts, record) => {
  const value = record[key];
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});

const proofById = new Map(proofManifest.records.map((record) => [record.capabilityId, record]));
const coverageById = new Map(prototypeCoverage.records.map((record) => [record.id, record]));
if (
  proofManifest.records.length !== capabilities.length
  || prototypeCoverage.records.length !== capabilities.length
  || capabilities.some(({ id }) => !proofById.has(id) || !coverageById.has(id))
) {
  throw new Error('Capability, proof, and prototype records must cover the same capability IDs.');
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');
}

const lines = [
  'Platen capability catalog',
  `Families: ${families.length}`,
  `Capabilities: ${capabilities.length}`,
  `Delivery: ${formatCounts(countBy(capabilities, 'delivery'))}`,
  `Proof: ${formatCounts(countBy(proofManifest.records, 'status'))}`,
  `Prototype coverage: ${formatCounts(countBy(prototypeCoverage.records, 'tier'))}`,
];

process.stdout.write(`${lines.join('\n')}\n`);
