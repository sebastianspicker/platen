import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';

function assertPolicy(policy) {
  assert.equal(policy.packageVersion, 1);
  assert.equal(policy.protocolVersion, 1);
  assert.equal(policy.v3DependenciesDisabled, true);
  assert.equal(policy.dependencyPins.exact, true);
  assert.deepEqual(policy.dependencyPins.fields, ['id', 'version', 'digest']);
  assert.equal(policy.dependencyPins.fields.join('|'), 'id|version|digest');
  assert.equal(policy.executableRuntime.kind, 'javascriptcore-classic-script');
  assert.equal(policy.executableRuntime.apiVersion, 1);
  assert.equal(policy.evaluationAuthority, 'advisory-only');
  assert.equal(policy.enforcementStages.length, 2);
  assert.equal(policy.enforcementStages[0].stage, 'manifest-validation');
  assert.equal(policy.enforcementStages[0].enforcedBy, 'signed-package-install');
  assert.equal(policy.enforcementStages[1].stage, 'activation-dependency-resolution');
  assert.equal(policy.enforcementStages[1].enforcedBy, 'plugin-package-store');
  assert.deepEqual(policy.manifestVersions, [2, 3]);
}

function assertPolicyFrozen(policy) {
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.manifestVersions), true);
  assert.equal(Object.isFrozen(policy.executableRuntime), true);
  assert.equal(Object.isFrozen(policy.dependencyPins), true);
  assert.equal(Object.isFrozen(policy.dependencyPins.fields), true);
  assert.equal(Object.isFrozen(policy.enforcementStages), true);
  assert.equal(Object.isFrozen(policy.enforcementStages[0]), true);
  assert.equal(Object.isFrozen(policy.enforcementStages[1]), true);
}

function assertNoHostVersionFields(outcome) {
  assert.equal(Object.hasOwn(outcome, 'hostVersion'), false);
  assert.equal(Object.hasOwn(outcome, 'minHost'), false);
}

test('platform plugin policy evaluation is fail-closed when manifest snapshot is omitted', async () => {
  const outcome = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
    packageId: 'org.example.policy',
  });
  assertPolicy(outcome.policy);
  assertPolicyFrozen(outcome.policy);
  assert.equal(outcome.method, 'local-plugin-package-policy-evaluation');
  assert.equal(outcome.executable, false);
  assert.equal(outcome.evaluated, false);
  assert.equal(outcome.compatible, false);
  assert.equal(outcome.authorizesInstall, false);
  assert.equal(outcome.authorizesActivation, false);
  assert.deepEqual(outcome.violations, ['manifest-not-provided']);
  assert.equal(Object.isFrozen(outcome.violations), true);
  assert.equal(Object.isFrozen(outcome), true);
  assertNoHostVersionFields(outcome);
});

test('platform plugin policy accepts a compatible v2 metadata snapshot', async () => {
  const outcome = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
    packageId: 'org.example.metadata',
    manifest: {
      packageVersion: 1,
      manifestVersion: 2,
      protocolVersion: 1,
      dependencies: [],
    },
  });
  assertPolicy(outcome.policy);
  assertPolicyFrozen(outcome.policy);
  assert.equal(outcome.evaluated, true);
  assert.equal(outcome.compatible, true);
  assert.deepEqual(outcome.violations, []);
  assert.equal(Object.isFrozen(outcome.violations), true);
  assert.equal(Object.isFrozen(outcome), true);
  assertNoHostVersionFields(outcome);
});

test('platform plugin policy accepts a supported executable v3 snapshot with zero dependencies', async () => {
  const outcome = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
    packageId: 'org.example.executable',
    manifest: {
      packageVersion: 1,
      manifestVersion: 3,
      protocolVersion: 1,
      runtime: {
        kind: 'javascriptcore-classic-script',
        apiVersion: 1,
      },
      dependencies: [],
    },
  });
  assertPolicy(outcome.policy);
  assertPolicyFrozen(outcome.policy);
  assert.equal(outcome.evaluated, true);
  assert.equal(outcome.compatible, true);
  assert.deepEqual(outcome.violations, []);
  assert.equal(Object.isFrozen(outcome.violations), true);
  assert.equal(Object.isFrozen(outcome), true);
  assertNoHostVersionFields(outcome);
});

test('platform plugin policy rejects unsupported manifest/protocol/runtime combinations', async () => {
  const cases = [
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 99,
        protocolVersion: 1,
        runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 },
        dependencies: [],
      },
      expected: ['manifest-version-unsupported'],
    },
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 2,
        protocolVersion: 2,
        dependencies: [],
        runtime: undefined,
      },
      expected: ['protocol-version-unsupported', 'manifest-v2-runtime-forbidden'],
    },
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 3,
        protocolVersion: 1,
        runtime: { kind: 'webview-script', apiVersion: 1 },
        dependencies: [],
      },
      expected: ['runtime-invalid'],
    },
  ];
  for (const { manifest, expected } of cases) {
    const outcome = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
      packageId: 'org.example.platform',
      manifest,
    });
    assertPolicy(outcome.policy);
    assert.equal(outcome.evaluated, true);
    assert.equal(outcome.compatible, false);
    assert.deepEqual(outcome.violations, expected);
  }
});

test('platform plugin dependency pins reject malformed, duplicate, and self references deterministically', async () => {
  const cases = [
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 2,
        protocolVersion: 1,
        dependencies: [{ id: Symbol('child'), version: 1, digest: null }],
      },
      expected: [
        'dependency-id-invalid',
        'dependency-version-invalid',
        'dependency-digest-invalid',
      ],
    },
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 2,
        protocolVersion: 1,
        dependencies: [{ id: 'org.example.child', version: '1.0', digest: 'a'.repeat(64) }],
      },
      expected: ['dependency-version-invalid'],
    },
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 2,
        protocolVersion: 1,
        dependencies: [{ id: 'org.example.platform', version: '1.0.0', digest: 'a'.repeat(64) }],
      },
      expected: ['dependency-self'],
    },
    {
      manifest: {
        packageVersion: 1,
        manifestVersion: 2,
        protocolVersion: 1,
        dependencies: [
          { id: 'org.example.child', version: '1.0.0', digest: 'a'.repeat(64) },
          { id: 'org.example.child', version: '1.0.0', digest: 'a'.repeat(64) },
        ],
      },
      expected: ['dependency-id-duplicate'],
    },
  ];
  for (const { manifest, expected } of cases) {
    const outcome = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
      packageId: 'org.example.platform',
      manifest,
    });
    assertPolicy(outcome.policy);
    assert.equal(outcome.compatible, false);
    assert.equal(outcome.evaluated, true);
    assert.deepEqual(outcome.violations, expected);
  }
});

test('changing legacy hostVersion/minHost inputs does not affect evaluation', async () => {
  const context = {
    packageId: 'org.example.host',
    manifest: {
      packageVersion: 1,
      manifestVersion: 2,
      protocolVersion: 1,
      dependencies: [],
    },
  };
  const base = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
    ...context,
  });
  const changed = await deliverProfessionalCapability('platform.plugins.version-compatibility', {
    ...context,
    hostVersion: '0.3.0',
    minHost: '0.1.0',
  });
  assert.deepEqual(base.evaluated, true);
  assert.deepEqual(changed.evaluated, true);
  assert.deepEqual(base.compatible, true);
  assert.deepEqual(changed.compatible, true);
  assert.deepEqual(base.violations, changed.violations);
  assertNoHostVersionFields(changed);
});
