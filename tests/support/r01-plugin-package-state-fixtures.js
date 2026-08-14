import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TrustedPublisherStore,
  canonicalizePluginPackage,
  pluginPackageSignedPayload,
  sha256,
  verifyPluginPackage,
} from '../../scripts/host/plugin-package.mjs';
import { PluginPackageStore } from '../../scripts/host/plugin-package-store.mjs';

export const PACKAGE_IDS = Object.freeze({
  child: 'org.example.r01child',
  root: 'org.example.r01root',
  conflict: 'org.example.r01conflict',
});

const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' });

export function trustedPublishers(pluginIds = Object.values(PACKAGE_IDS)) {
  const publishers = new TrustedPublisherStore();
  publishers.enroll({
    publisherId: 'org.example',
    keyId: 'r01-test-key',
    publicKey,
    pluginIds,
  });
  return publishers;
}

export function signedPackage({
  id = PACKAGE_IDS.root,
  version = '1.0.0',
  dependencies = [],
  content = `registerPlugin({invoke: (input) => ({id: '${id}', input})});`,
} = {}) {
  const bytes = Buffer.from(content);
  const value = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 2,
      id,
      name: 'R01 package-state fixture',
      version,
      protocolVersion: 1,
      entry: 'index.mjs',
      capabilities: ['document.example'],
      permissions: [{ name: 'document.metadata', reason: 'Read local metadata.' }],
      dependencies,
      activation: 'manual',
    },
    files: [{
      path: 'index.mjs',
      mediaType: 'text/javascript',
      size: bytes.length,
      sha256: sha256(bytes),
      content: bytes.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519',
      publisherId: 'org.example',
      keyId: 'r01-test-key',
      value: '',
    },
  };
  value.signature.value = sign(
    null,
    Buffer.from(pluginPackageSignedPayload(value)),
    keyPair.privateKey,
  ).toString('base64');
  return value;
}

export function packageBytes(value) {
  return Buffer.from(canonicalizePluginPackage(value));
}

export function packageDigest(value, publishers = trustedPublishers()) {
  return verifyPluginPackage(value, publishers).digest;
}

export async function createStore(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r01-package-state-'));
  const publishers = trustedPublishers(options.pluginIds);
  const store = await new PluginPackageStore({
    root,
    trustedPublishers: publishers,
    activationTransition: options.activationTransition,
  }).initialize();
  t.after(() => removeStore(root));
  return { root, publishers, store };
}

export async function removeStore(root) {
  await chmod(root, 0o700).catch(() => {});
  await chmod(join(root, 'packages'), 0o700).catch(() => {});
  for (const digest of await readdir(join(root, 'packages')).catch(() => [])) {
    await chmod(join(root, 'packages', digest), 0o700).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}
