import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityCatalog } from '../../src/browser/api/local-host-plugin-package-endpoints.js';
import { collectSelectedExtensionMetadataCatalog } from '../../src/host/application/plugins/selected-extension-metadata-catalog.mjs';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function selectedPackage(id, version, digest) {
  return {
    id,
    version,
    digest,
    manifest: {
      manifestVersion: 1,
      id,
      name: `${id} metadata`,
      version,
      description: 'Signed inert extension metadata.',
      capabilities: ['review.metadata'],
    },
    publisher: { publisherId: 'example.publisher', keyId: 'fixture-key' },
  };
}

test('selected extension metadata catalog reports duplicate declarations without provider selection', async () => {
  const catalog = await collectSelectedExtensionMetadataCatalog({
    listPlugins() {
      return [
        { id: 'example.extension-a', selectedVersion: '1.0.0', previousSelectedVersion: null, versions: [{ version: '1.0.0', digest: DIGEST_A }] },
        { id: 'example.extension-b', selectedVersion: '1.0.0', previousSelectedVersion: null, versions: [{ version: '1.0.0', digest: DIGEST_B }] },
      ];
    },
    getSelectedPackage(id) {
      return selectedPackage(id, '1.0.0', id.endsWith('a') ? DIGEST_A : DIGEST_B);
    },
  });

  assert.equal(catalog.kind, 'selected-extension-metadata-catalog');
  assert.deepEqual(catalog.duplicateDeclarations, [{
    capabilityId: 'review.metadata',
    packageIds: ['example.extension-a', 'example.extension-b'],
  }]);
  assert.equal('selectedProviderId' in catalog.duplicateDeclarations[0], false);
  assert.deepEqual(capabilityCatalog(catalog), catalog);
});

test('selected extension metadata catalog rejects obsolete active-version records', async () => {
  await assert.rejects(
    collectSelectedExtensionMetadataCatalog({
      listPlugins() {
        return [{ id: 'example.extension', activeVersion: '1.0.0', previousVersion: null, versions: [{ version: '1.0.0', digest: DIGEST_A }] }];
      },
      getSelectedPackage() { throw new Error('not reached'); },
    }),
    { code: 'PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID' },
  );
});
