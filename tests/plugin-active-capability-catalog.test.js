import assert from 'node:assert/strict';
import test from 'node:test';
import { collectActivePluginCapabilityCatalog } from '../scripts/host/plugin-active-capability-catalog.mjs';

const VERSIONED = '1.0.0';
const ALT_VERSION = '2.0.0';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function launchDescriptor({
  id = 'org.example.one',
  version = VERSIONED,
  digest = DIGEST_A,
  capabilities = ['document.example'],
  entrySha256 = DIGEST_A,
  packageRoot = '/tmp/catalog-plugin-root',
} = {}) {
  return {
    id,
    version,
    digest,
    packageHash: digest,
    manifest: {
      manifestVersion: 3,
      id,
      name: 'Example plugin',
      version,
      protocolVersion: 1,
      entry: 'index.js',
      capabilities,
      permissions: [{ name: 'document.read.bytes', reason: 'Read local PDF bytes.' }],
      dependencies: [],
      activation: 'manual',
      runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 },
    },
    publisher: { publisherId: 'org.example', keyId: 'test-key' },
    packageRoot,
    entryPath: `${packageRoot}/index.js`,
    inventory: [
      { path: 'index.js', mediaType: 'text/javascript', size: 2, sha256: entrySha256 },
    ],
    dependencies: [],
    executableRuntime: {
      kind: 'javascriptcore-classic-script', apiVersion: 1, entry: 'index.js', sha256: entrySha256,
    },
  };
}

function metadataOnlyDescriptor({
  id = 'org.example.metadata',
  version = VERSIONED,
  digest = DIGEST_C,
} = {}) {
  const descriptor = launchDescriptor({ id, version, digest, entrySha256: digest });
  descriptor.manifest.manifestVersion = 2;
  descriptor.manifest.entry = 'index.mjs';
  delete descriptor.manifest.runtime;
  descriptor.entryPath = `${descriptor.packageRoot}/index.mjs`;
  descriptor.inventory = [{ path: 'index.mjs', mediaType: 'text/javascript', size: 2, sha256: digest }];
  descriptor.executableRuntime = null;
  return descriptor;
}

function authority({ pluginRecords, descriptors }) {
  const calls = [];
  return {
    calls,
    listPlugins: async () => pluginRecords,
    getLaunchDescriptor: async (id) => {
      calls.push(id);
      return descriptors[id];
    },
  };
}

test('deterministic positive catalog collection preserves active-only packages and sorts deterministically', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.second', activeVersion: ALT_VERSION, previousVersion: null, versions: [{ version: ALT_VERSION, digest: DIGEST_B }] },
      { id: 'org.example.first', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] },
    ],
    descriptors: {
      'org.example.second': launchDescriptor({
        id: 'org.example.second',
        version: ALT_VERSION,
        digest: DIGEST_B,
        capabilities: ['write.first', 'document.second'],
      }),
      'org.example.first': launchDescriptor({
        id: 'org.example.first',
        version: VERSIONED,
        digest: DIGEST_A,
        capabilities: ['document.first', 'admin.second'],
      }),
    },
  });
  const first = await collectActivePluginCapabilityCatalog(auth);
  const second = await collectActivePluginCapabilityCatalog(auth);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.kind, 'active-plugin-capability-catalog');
  assert.equal(first.localOnly, true);
  assert.equal(first.executablePackagesOnly, true);
  assert.equal(first.catalogOnlyExecution, true);
  assert.equal(first.conflictResolution, 'lexicographic-plugin-id');
  assert.equal(first.conflictCount, 0);
  assert.deepEqual(first.conflicts, []);
  assert.equal(first.count, 2);
  assert.deepEqual(first.packageIds, ['org.example.first', 'org.example.second']);
  assert.deepEqual(first.packages.map((entry) => entry.capabilities), [
    ['admin.second', 'document.first'],
    ['document.second', 'write.first'],
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(auth.calls, ['org.example.first', 'org.example.second', 'org.example.first', 'org.example.second']);
});

test('inactive packages are skipped without descriptor fetches', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.active', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] },
      { id: 'org.example.inactive', activeVersion: null, previousVersion: null, versions: [] },
    ],
    descriptors: {
      'org.example.active': launchDescriptor({
        id: 'org.example.active',
        version: VERSIONED,
        digest: DIGEST_A,
      }),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  assert.equal(catalog.count, 1);
  assert.deepEqual(catalog.packageIds, ['org.example.active']);
  assert.deepEqual(auth.calls, ['org.example.active']);
});

test('active metadata-only packages are omitted from the executable package catalog', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.metadata', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_C }] },
    ],
    descriptors: {
      'org.example.metadata': metadataOnlyDescriptor(),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  assert.equal(catalog.executablePackagesOnly, true);
  assert.equal(catalog.count, 0);
  assert.deepEqual(catalog.packageIds, []);
  assert.equal(catalog.conflictResolution, 'lexicographic-plugin-id');
  assert.equal(catalog.conflictCount, 0);
  assert.deepEqual(catalog.conflicts, []);
});

test('metadata-only packages do not contribute providers to executable conflicts', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.metadata', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_C }] },
      { id: 'org.example.executable', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] },
    ],
    descriptors: {
      'org.example.metadata': metadataOnlyDescriptor({ id: 'org.example.metadata', digest: DIGEST_C }),
      'org.example.executable': launchDescriptor({
        id: 'org.example.executable', digest: DIGEST_A, capabilities: ['document.shared'],
      }),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  assert.deepEqual(catalog.packageIds, ['org.example.executable']);
  assert.equal(catalog.conflictCount, 0);
  assert.deepEqual(catalog.conflicts, []);
});

test('overlapping capabilities derive deterministic ordered conflicts from executable packages', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.zeta', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_C }] },
      { id: 'org.example.alpha', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] },
      { id: 'org.example.mid', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_B }] },
    ],
    descriptors: {
      'org.example.zeta': launchDescriptor({
        id: 'org.example.zeta', digest: DIGEST_C, capabilities: ['capability.z', 'capability.shared', 'capability.alpha'],
      }),
      'org.example.alpha': launchDescriptor({
        id: 'org.example.alpha', digest: DIGEST_A, capabilities: ['capability.shared', 'capability.alpha'],
      }),
      'org.example.mid': launchDescriptor({
        id: 'org.example.mid', digest: DIGEST_B, capabilities: ['capability.shared', 'capability.z'],
      }),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  assert.equal(catalog.conflictResolution, 'lexicographic-plugin-id');
  assert.equal(catalog.conflictCount, 3);
  assert.deepEqual(catalog.conflicts, [
    {
      capabilityId: 'capability.alpha',
      providerIds: ['org.example.alpha', 'org.example.zeta'],
      selectedProviderId: 'org.example.alpha',
    },
    {
      capabilityId: 'capability.shared',
      providerIds: ['org.example.alpha', 'org.example.mid', 'org.example.zeta'],
      selectedProviderId: 'org.example.alpha',
    },
    {
      capabilityId: 'capability.z',
      providerIds: ['org.example.mid', 'org.example.zeta'],
      selectedProviderId: 'org.example.mid',
    },
  ]);
});

test('absent authority is rejected', async () => {
  await assert.rejects(
    collectActivePluginCapabilityCatalog(),
    { code: 'PLUGIN_ACTIVE_CAPABILITY_CATALOG_AUTHORITY_MISSING' },
  );
});

test('descriptor drift is rejected when active package metadata changes', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }, { version: ALT_VERSION, digest: DIGEST_B }] },
    ],
    descriptors: {
      'org.example.one': launchDescriptor({
        id: 'org.example.one',
        version: ALT_VERSION,
        digest: DIGEST_B,
      }),
    },
  });
  await assert.rejects(
    collectActivePluginCapabilityCatalog(auth),
    { code: 'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DRIFT' },
  );
});

test('malformed and duplicate capability IDs are rejected', async () => {
  const malformed = authority({
    pluginRecords: [{ id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] }],
    descriptors: {
      'org.example.one': launchDescriptor({
        id: 'org.example.one',
        version: VERSIONED,
        digest: DIGEST_A,
        capabilities: ['bad capability', 'document.example'],
      }),
    },
  });
  await assert.rejects(
    collectActivePluginCapabilityCatalog(malformed),
    { code: 'PLUGIN_ACTIVE_CAPABILITY_CATALOG_CAPABILITY_ID_INVALID' },
  );

  const duplicate = authority({
    pluginRecords: [{ id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] }],
    descriptors: {
      'org.example.one': launchDescriptor({
        id: 'org.example.one',
        version: VERSIONED,
        digest: DIGEST_A,
        capabilities: ['document.example', 'document.example'],
      }),
    },
  });
  await assert.rejects(
    collectActivePluginCapabilityCatalog(duplicate),
    { code: 'PLUGIN_ACTIVE_CAPABILITY_CATALOG_CAPABILITY_ID_INVALID' },
  );
});

test('malformed publisher data and accessor-backed registry records fail with stable host errors', async () => {
  const malformedPublisher = launchDescriptor();
  malformedPublisher.publisher = null;
  await assert.rejects(
    collectActivePluginCapabilityCatalog(authority({
      pluginRecords: [{ id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] }],
      descriptors: { 'org.example.one': malformedPublisher },
    })),
    { code: 'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID', status: 502 },
  );

  const accessorRecord = {
    get id() { throw new Error('must not invoke registry getters'); },
    activeVersion: VERSIONED,
    previousVersion: null,
    versions: [{ version: VERSIONED, digest: DIGEST_A }],
  };
  await assert.rejects(
    collectActivePluginCapabilityCatalog(authority({ pluginRecords: [accessorRecord], descriptors: {} })),
    { code: 'PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID', status: 500 },
  );
});

test('catalog output redacts package paths and runtime source fields', async () => {
  const auth = authority({
    pluginRecords: [{ id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_C }] }],
    descriptors: {
      'org.example.one': launchDescriptor({
        id: 'org.example.one',
        version: VERSIONED,
        digest: DIGEST_C,
        packageRoot: '/tmp/secret-plugin-root',
        entrySha256: DIGEST_C,
      }),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  const entry = catalog.packages[0];
  assert.equal(Object.hasOwn(entry, 'packageRoot'), false);
  assert.equal(Object.hasOwn(entry, 'entryPath'), false);
  assert.equal(Object.hasOwn(entry, 'inventory'), false);
  assert.equal(Object.hasOwn(entry, 'executableRuntime'), false);
  assert.equal(Object.hasOwn(entry.publisher, 'privateKey'), false);
  assert.equal(JSON.stringify(catalog).includes('/tmp/secret-plugin-root'), false);
});

test('output is deeply frozen and immutable', async () => {
  const auth = authority({
    pluginRecords: [{ id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] }],
    descriptors: {
      'org.example.one': launchDescriptor({
        id: 'org.example.one',
        version: VERSIONED,
        digest: DIGEST_A,
      }),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.packageIds), true);
  assert.equal(Object.isFrozen(catalog.packages), true);
  assert.equal(Object.isFrozen(catalog.packages[0]), true);
  assert.equal(Object.isFrozen(catalog.packages[0].publisher), true);
  assert.equal(Object.isFrozen(catalog.packages[0].capabilities), true);
  assert.equal(Object.isFrozen(catalog.conflicts), true);
  assert.throws(() => { catalog.count = 3; });
  assert.throws(() => { catalog.packageIds.push('org.example.other'); });
  assert.throws(() => { catalog.packages.push('org.example.other'); });
  assert.throws(() => { catalog.packages[0].capabilities.push('document.other'); });
});

test('conflict entries are exact and deeply immutable', async () => {
  const auth = authority({
    pluginRecords: [
      { id: 'org.example.one', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_A }] },
      { id: 'org.example.two', activeVersion: VERSIONED, previousVersion: null, versions: [{ version: VERSIONED, digest: DIGEST_B }] },
    ],
    descriptors: {
      'org.example.one': launchDescriptor({ id: 'org.example.one', digest: DIGEST_A, capabilities: ['document.shared'] }),
      'org.example.two': launchDescriptor({ id: 'org.example.two', digest: DIGEST_B, capabilities: ['document.shared'] }),
    },
  });
  const catalog = await collectActivePluginCapabilityCatalog(auth);
  const conflict = catalog.conflicts[0];
  assert.deepEqual(Reflect.ownKeys(conflict), ['capabilityId', 'providerIds', 'selectedProviderId']);
  assert.equal(Object.isFrozen(conflict), true);
  assert.equal(Object.isFrozen(conflict.providerIds), true);
  assert.throws(() => { conflict.selectedProviderId = 'org.example.two'; });
  assert.throws(() => { conflict.providerIds.push('org.example.three'); });
  assert.throws(() => { catalog.conflicts.push(conflict); });
});

test('pre-cancelled collection rejects before reading package authority', async () => {
  let listed = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectActivePluginCapabilityCatalog({
      listPlugins() { listed = true; return []; },
      getLaunchDescriptor() { throw new Error('must not fetch'); },
    }, { signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  assert.equal(listed, false);
});
