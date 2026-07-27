import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  PACKAGE_LIMITS,
  isPlainObject,
  packageFailure,
} from './plugin-package-contract.mjs';

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      packageFailure('PACKAGE_INVALID', 'Package contains a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (!isPlainObject(value)) packageFailure('PACKAGE_INVALID', 'Package contains a non-JSON value.');
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`,
  ).join(',')}}`;
}

export function canonicalizePluginPackage(value) {
  return canonicalValue(value);
}

export function pluginPackageSignedPayload(pluginPackage) {
  return canonicalizePluginPackage({
    packageVersion: pluginPackage.packageVersion,
    manifest: pluginPackage.manifest,
    files: pluginPackage.files,
    signature: {
      algorithm: pluginPackage.signature?.algorithm,
      publisherId: pluginPackage.signature?.publisherId,
      keyId: pluginPackage.signature?.keyId,
    },
  });
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parsePluginPackage(input) {
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    let raw;
    try {
      raw = Buffer.isBuffer(input)
        ? new TextDecoder('utf-8', { fatal: true }).decode(input)
        : input;
    } catch {
      packageFailure('PACKAGE_INVALID_UTF8', 'Plugin package bytes must be valid UTF-8.');
    }
    if (Buffer.byteLength(raw) > PACKAGE_LIMITS.maxEncodedBytes) {
      packageFailure(
        'PACKAGE_TOO_LARGE',
        'Plugin package JSON exceeds the local package limit.',
        413,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      packageFailure('PACKAGE_INVALID_JSON', 'Plugin package is not valid JSON.');
    }
    if (canonicalizePluginPackage(parsed) !== raw) {
      packageFailure(
        'PACKAGE_NONCANONICAL',
        'Serialized plugin packages must use canonical JSON without duplicate keys.',
      );
    }
    return parsed;
  }
  if (!isPlainObject(input)) packageFailure('PACKAGE_INVALID', 'Plugin package must be a JSON object.');
  const cloned = structuredClone(input);
  if (Buffer.byteLength(canonicalizePluginPackage(cloned)) > PACKAGE_LIMITS.maxEncodedBytes) {
    packageFailure(
      'PACKAGE_TOO_LARGE',
      'Plugin package JSON exceeds the local package limit.',
      413,
    );
  }
  return cloned;
}
