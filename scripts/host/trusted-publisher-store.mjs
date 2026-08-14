import { createPublicKey } from 'node:crypto';
import {
  PLUGIN_ID,
  SHA256,
  TRUST_PUBLISHER_FIELDS,
  TRUST_STATE_FIELDS,
  assertExactKeys,
  packageFailure,
} from './plugin-package-contract.mjs';
import { sha256 } from './plugin-package-codec.mjs';

export class TrustedPublisherStore {
  #publishers = new Map();

  #fingerprints = new Map();

  enroll({ publisherId, keyId, publicKey, pluginIds }) {
    if (!PLUGIN_ID.test(publisherId) || typeof keyId !== 'string'
      || !/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) {
      packageFailure('TRUST_KEY_INVALID', 'Publisher identity or key ID is invalid.');
    }
    if (typeof publicKey !== 'string' || !publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')
      || !publicKey.endsWith('-----END PUBLIC KEY-----\n')) {
      packageFailure('TRUST_KEY_INVALID', 'Publisher enrollment accepts PEM public keys only.');
    }
    let key;
    try {
      key = createPublicKey(publicKey);
    } catch {
      packageFailure('TRUST_KEY_INVALID', 'Publisher public key is invalid.');
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      packageFailure('TRUST_KEY_INVALID', 'Only Ed25519 publisher keys are accepted.');
    }
    if (!Array.isArray(pluginIds) || !pluginIds.length
      || pluginIds.some((pluginId) => !PLUGIN_ID.test(pluginId))
      || new Set(pluginIds).size !== pluginIds.length) {
      packageFailure(
        'TRUST_SCOPE_INVALID',
        'Publisher keys require an explicit unique plugin-ID scope.',
      );
    }
    const fingerprint = sha256(key.export({ type: 'spki', format: 'der' }));
    const owner = this.#fingerprints.get(fingerprint);
    if (owner && owner !== `${publisherId}:${keyId}`) {
      packageFailure(
        'TRUST_KEY_AMBIGUOUS',
        'A publisher key fingerprint may only have one identity.',
        409,
      );
    }
    const keys = this.#publishers.get(publisherId) ?? new Map();
    if (keys.has(keyId)) {
      packageFailure('TRUST_KEY_EXISTS', 'Publisher key ID is already enrolled.', 409);
    }
    keys.set(keyId, { publicKey: key, revoked: false, pluginIds: new Set(pluginIds) });
    this.#publishers.set(publisherId, keys);
    this.#fingerprints.set(fingerprint, `${publisherId}:${keyId}`);
    return Object.freeze({
      publisherId,
      keyId,
      fingerprint,
      pluginIds: Object.freeze([...pluginIds].sort()),
    });
  }

  revoke({ publisherId, keyId }) {
    const key = this.#publishers.get(publisherId)?.get(keyId);
    if (!key) packageFailure('TRUST_KEY_NOT_FOUND', 'Trusted publisher key was not found.', 404);
    key.revoked = true;
  }

  get(publisherId, keyId) {
    const trusted = this.#publishers.get(publisherId)?.get(keyId);
    if (!trusted) return null;
    return Object.freeze({
      publicKey: trusted.publicKey,
      revoked: trusted.revoked,
      pluginIds: Object.freeze([...trusted.pluginIds].sort()),
    });
  }

  exportState() {
    const publishers = [];
    for (const [publisherId, keys] of this.#publishers) {
      for (const [keyId, trusted] of keys) {
        publishers.push({
          publisherId,
          keyId,
          publicKey: trusted.publicKey.export({ type: 'spki', format: 'pem' }),
          fingerprint: sha256(trusted.publicKey.export({ type: 'spki', format: 'der' })),
          revoked: trusted.revoked,
          pluginIds: [...trusted.pluginIds].sort(),
        });
      }
    }
    publishers.sort((left, right) => `${left.publisherId}:${left.keyId}`
      .localeCompare(`${right.publisherId}:${right.keyId}`, 'en'));
    return Object.freeze({
      schemaVersion: 1,
      publishers: Object.freeze(publishers.map((entry) => Object.freeze({
        ...entry,
        pluginIds: Object.freeze(entry.pluginIds),
      }))),
    });
  }

  importState(state) {
    assertExactKeys(state, TRUST_STATE_FIELDS, 'Trusted publisher state');
    if (state.schemaVersion !== 1 || !Array.isArray(state.publishers)) {
      packageFailure('TRUST_STATE_INVALID', 'Trusted publisher state is invalid.');
    }
    const replacement = new TrustedPublisherStore();
    for (const entry of state.publishers) {
      assertExactKeys(entry, TRUST_PUBLISHER_FIELDS, 'Trusted publisher entry');
      if (typeof entry.revoked !== 'boolean' || typeof entry.fingerprint !== 'string'
        || !SHA256.test(entry.fingerprint)) {
        packageFailure('TRUST_STATE_INVALID', 'Trusted publisher state is invalid.');
      }
      const enrolled = replacement.enroll(entry);
      if (enrolled.fingerprint !== entry.fingerprint) {
        packageFailure(
          'TRUST_STATE_INVALID',
          'Trusted publisher fingerprint does not match its public key.',
        );
      }
      replacement.#publishers.get(entry.publisherId).get(entry.keyId).revoked = entry.revoked;
    }
    this.#publishers = replacement.#publishers;
    this.#fingerprints = replacement.#fingerprints;
    return this.exportState();
  }
}
