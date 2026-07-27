import { verify } from 'node:crypto';
import {
  BASE64,
  PACKAGE_FIELDS,
  PLUGIN_ID,
  SIGNATURE_FIELDS,
  assertExactKeys,
  packageFailure,
} from './plugin-package-contract.mjs';
import {
  canonicalizePluginPackage,
  parsePluginPackage,
  pluginPackageSignedPayload,
  sha256,
} from './plugin-package-codec.mjs';
import { validatePluginPackageManifest } from './plugin-package-manifest-validation.mjs';
import { TrustedPublisherStore } from './trusted-publisher-store.mjs';

export { PACKAGE_LIMITS } from './plugin-package-contract.mjs';
export {
  canonicalizePluginPackage,
  pluginPackageSignedPayload,
  sha256,
} from './plugin-package-codec.mjs';
export { TrustedPublisherStore } from './trusted-publisher-store.mjs';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateSignature(pluginPackage, trustedPublishers) {
  assertExactKeys(pluginPackage.signature, SIGNATURE_FIELDS, 'Plugin signature');
  const { algorithm, publisherId, keyId, value } = pluginPackage.signature;
  if (algorithm !== 'ed25519' || !PLUGIN_ID.test(publisherId) || typeof keyId !== 'string'
    || !BASE64.test(value) || Buffer.from(value, 'base64').toString('base64') !== value
    || Buffer.from(value, 'base64').length !== 64) {
    packageFailure('PACKAGE_SIGNATURE_INVALID', 'Plugin package signature is invalid.');
  }
  if (!(trustedPublishers instanceof TrustedPublisherStore)) {
    packageFailure(
      'TRUST_STORE_REQUIRED',
      'Plugin package verification requires an external trusted publisher store.',
      500,
    );
  }
  const trusted = trustedPublishers.get(publisherId, keyId);
  if (!trusted) packageFailure('PUBLISHER_UNTRUSTED', 'Plugin publisher key is not trusted.', 403);
  if (trusted.revoked) packageFailure('PUBLISHER_REVOKED', 'Plugin publisher key is revoked.', 403);
  if (!trusted.pluginIds.includes(pluginPackage.manifest.id)) {
    packageFailure(
      'PUBLISHER_SCOPE_DENIED',
      'Publisher key is not trusted for this plugin ID.',
      403,
    );
  }
  if (!verify(
    null,
    Buffer.from(pluginPackageSignedPayload(pluginPackage)),
    trusted.publicKey,
    Buffer.from(value, 'base64'),
  )) {
    packageFailure(
      'PACKAGE_SIGNATURE_INVALID',
      'Plugin package signature verification failed.',
    );
  }
  return Object.freeze({ publisherId, keyId });
}

export function verifyPluginPackage(input, trustedPublishers) {
  const pluginPackage = parsePluginPackage(input);
  assertExactKeys(pluginPackage, PACKAGE_FIELDS, 'Plugin package');
  const { decodedFiles, executableRuntime } = validatePluginPackageManifest(pluginPackage);
  const publisher = validateSignature(pluginPackage, trustedPublishers);
  const digest = sha256(canonicalizePluginPackage(pluginPackage));
  const contents = new Map(decodedFiles.map((file) => [file.path, Buffer.from(file.content)]));
  return Object.freeze({
    digest,
    manifest: deepFreeze(structuredClone(pluginPackage.manifest)),
    publisher,
    signature: deepFreeze(structuredClone(pluginPackage.signature)),
    files: Object.freeze(decodedFiles.map(({ content, ...file }) => Object.freeze(file))),
    executableRuntime,
    getContent(filePath) {
      const content = contents.get(filePath);
      if (!content) {
        packageFailure(
          'PACKAGE_CONTENT_NOT_FOUND',
          'Verified package content was not found.',
          500,
        );
      }
      return Buffer.from(content);
    },
  });
}
