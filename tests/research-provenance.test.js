import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const provenance = readJson('catalog/research-provenance.json');
const families = readJson('catalog/families.json');
const scope = readJson('catalog/research-scope.json');
const sourceIdPattern = /^[a-z][a-z0-9-]*$/;

const expectedEvidence = {
  'view-navigation': {
    sourceIds: ['abbyy-finereader-pdf', 'adobe-acrobat-tools'],
    locator: 'ABBYY feature list pages 1-2: Edit, protect, and collaborate on PDFs > Viewing; Adobe: Searching and indexing',
  },
  'create-convert': {
    sourceIds: ['foxit-pdf-editor', 'adobe-acrobat-tools'],
    locator: 'Foxit Compare Features > Create & Convert PDFs; Adobe > Saving and exporting PDFs',
  },
  'content-editing': {
    sourceIds: ['foxit-pdf-editor', 'adobe-acrobat-tools'],
    locator: 'Foxit Compare Features > Core PDF Editing; Adobe > Modify your content with the Edit tools',
  },
  'page-organization': {
    sourceIds: ['foxit-pdf-editor', 'adobe-acrobat-tools'],
    locator: 'Foxit Compare Features > Core PDF Editing (add, delete, reorder, merge, split, rotate, crop); Adobe > Edit PDFs',
  },
  'annotations-review': {
    sourceIds: ['foxit-pdf-editor', 'adobe-acrobat-tools'],
    locator: 'Foxit Compare Features > Collaboration & Commenting; Adobe > Sharing, reviews, and commenting',
  },
  forms: {
    sourceIds: ['foxit-pdf-editor', 'adobe-acrobat-tools'],
    locator: 'Foxit Compare Features > Forms & Signatures; Adobe > Forms',
  },
  signatures: {
    sourceIds: ['adobe-acrobat-tools', 'abbyy-finereader-pdf'],
    locator: 'Adobe > Electronic signatures; ABBYY feature list page 4: Protect and sign PDFs',
  },
  'scan-ocr': {
    sourceIds: ['abbyy-finereader-pdf', 'foxit-pdf-editor'],
    locator: 'ABBYY feature list pages 6-10: Digitize documents and scans with Optical Character Recognition (OCR); Foxit > Scan & OCR',
  },
  security: {
    sourceIds: ['adobe-acrobat-tools', 'abbyy-finereader-pdf'],
    locator: 'Adobe > Security; ABBYY feature list page 4: Protect and sign PDFs',
  },
  'redaction-sanitization': {
    sourceIds: ['foxit-pdf-editor', 'abbyy-finereader-pdf'],
    locator: 'Foxit Compare Features > Security & Protection; ABBYY feature list page 4: redaction and hidden-information removal',
  },
  comparison: {
    sourceIds: ['abbyy-finereader-pdf', 'foxit-pdf-editor'],
    locator: 'ABBYY feature list pages 5-6: Compare documents in different formats; Foxit Compare Features > Core PDF Editing > Compare PDF versions',
  },
  accessibility: {
    sourceIds: ['adobe-acrobat-tools', 'foxit-pdf-editor'],
    locator: 'Adobe > Accessibility, tags, and reflow; Foxit Compare Features > Accessibility validation',
  },
  'standards-preflight-print': {
    sourceIds: ['adobe-acrobat-tools', 'callas-pdftoolbox', 'enfocus-pitstop-pro'],
    locator: 'Adobe > Print production tools and Preflight; callas > Conditional processing and more; Enfocus > Preflight: Automatically check and fix your PDFs before they go to print',
  },
  'collaboration-dms': {
    sourceIds: ['bluebeam-revu', 'foxit-pdf-editor'],
    locator: 'Bluebeam subscription features > Studio and Integrations; Foxit Compare Features > Collaboration & Commenting and DMS',
  },
  'automation-headless': {
    sourceIds: ['callas-pdftoolbox', 'abbyy-finereader-pdf'],
    locator: 'callas > Conditional processing and more, Variants: Desktop, Server, CLI, SDK; ABBYY feature list page 10: Automate digitization, conversion, and comparison routines',
  },
  ai: {
    sourceIds: ['adobe-acrobat-tools', 'foxit-pdf-editor'],
    locator: 'Adobe > Interact with documents using AI Assistant; Foxit Compare Features > AI Assistant',
  },
  aec: {
    sourceIds: ['bluebeam-revu'],
    locator: 'Bluebeam subscription features > Measurements, Markups List, and Studio and Integrations',
  },
  'rich-media-3d-portfolios': {
    sourceIds: ['adobe-acrobat-tools', 'bluebeam-revu'],
    locator: 'Adobe > Multimedia and 3D models and Edit PDFs > PDF Portfolios; Bluebeam > capture media and manipulate 3D PDFs',
  },
  'integrations-admin': {
    sourceIds: ['foxit-pdf-editor', 'bluebeam-revu'],
    locator: 'Foxit Compare Features > Platform & Integrations and FAQ > enterprise admin console; Bluebeam > Plugins and Apps',
  },
  'plugin-platform': {
    sourceIds: ['bluebeam-revu', 'foxit-pdf-editor'],
    locator: 'Bluebeam subscription features > Plugins and Apps; Foxit Compare Features > Platform & Integrations (extension-ecosystem evidence only, not runtime sandbox or RPC proof)',
  },
};

function exactKeys(value, expected, label) {
  assert.equal(value && typeof value, 'object', `${label} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has exactly the contract keys`);
}

test('research provenance is family-level research evidence, not product or implementation proof', () => {
  exactKeys(provenance, ['schemaVersion', 'snapshotDate', 'evidencePurpose', 'notImplementationEvidence', 'methodology', 'sources', 'families'], 'research provenance');
  assert.equal(provenance.schemaVersion, 1);
  assert.match(provenance.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(provenance.evidencePurpose, 'market-research-provenance');
  assert.equal(provenance.notImplementationEvidence, true);
  assert.match(provenance.methodology, /does not claim per-command product support/i);
});

test('source records are unique, HTTPS, and exactly match the official research scope', () => {
  const sourceIds = provenance.sources.map(({ id }) => id);
  assert.equal(new Set(sourceIds).size, sourceIds.length, 'source IDs are unique');
  assert.deepEqual(new Set(provenance.sources.map(({ url }) => url)), new Set(scope.products.map(({ source }) => source)), 'sources are exactly the reviewed official product URLs');
  for (const source of provenance.sources) {
    exactKeys(source, ['id', 'product', 'url', 'reviewedDate'], `source ${source.id}`);
    assert.match(source.id, sourceIdPattern);
    assert.match(source.product, /\S/);
    assert.match(source.url, /^https:\/\//);
    assert.equal(source.reviewedDate, provenance.snapshotDate);
  }
});

test('pinned source and locator pairs close exactly over every feature family', () => {
  const knownSourceIds = new Set(provenance.sources.map(({ id }) => id));
  const provenanceIds = provenance.families.map(({ familyId }) => familyId);
  assert.equal(new Set(provenanceIds).size, provenanceIds.length, 'every family has one provenance record');
  assert.deepEqual(new Set(provenanceIds), new Set(families.map(({ id }) => id)), 'provenance has exact family closure');
  assert.deepEqual(new Set(Object.keys(expectedEvidence)), new Set(families.map(({ id }) => id)), 'pinned evidence covers every family');
  for (const entry of provenance.families) {
    exactKeys(entry, ['familyId', 'sourceIds', 'evidenceGranularity', 'locator'], `provenance ${entry.familyId}`);
    assert.equal(entry.evidenceGranularity, 'feature-family');
    assert.deepEqual(
      { sourceIds: entry.sourceIds, locator: entry.locator },
      expectedEvidence[entry.familyId],
      `${entry.familyId} keeps its reviewed source and locator pair`,
    );
    for (const sourceId of entry.sourceIds) assert.ok(knownSourceIds.has(sourceId), `${entry.familyId} references ${sourceId}`);
  }
});
