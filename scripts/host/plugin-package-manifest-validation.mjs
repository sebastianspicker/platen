import { TextDecoder } from 'node:util';
import {
  CAPABILITY_ID,
  FILE_FIELDS,
  JAVASCRIPTCORE_CLASSIC_RUNTIME,
  JAVASCRIPT_MEDIA_TYPES,
  LOCAL_PERMISSIONS,
  MANIFEST_V2_FIELDS,
  MANIFEST_V3_FIELDS,
  PACKAGE_LIMITS,
  PLUGIN_ID,
  RESERVED_PACKAGE_PATHS,
  RUNTIME_FIELDS,
  SAFE_MEDIA_TYPE,
  SAFE_PATH_SEGMENT,
  SEMVER,
  SHA256,
  BASE64,
  assertExactKeys,
  isPlainObject,
  packageFailure,
} from './plugin-package-contract.mjs';
import { sha256 } from './plugin-package-codec.mjs';

function validatePath(filePath) {
  if (typeof filePath !== 'string' || !filePath
    || filePath.length > PACKAGE_LIMITS.maxPathLength) {
    packageFailure('PACKAGE_PATH_INVALID', 'Package file path is invalid.');
  }
  if (!/^[\x20-\x7e]+$/.test(filePath) || filePath.includes('%')
    || filePath.includes('\\') || filePath.startsWith('/') || filePath.includes('//')) {
    packageFailure(
      'PACKAGE_PATH_INVALID',
      'Package paths must be unambiguous relative ASCII paths.',
    );
  }
  const parts = filePath.split('/');
  if (parts.length > PACKAGE_LIMITS.maxPathDepth
    || parts.some((part) => !SAFE_PATH_SEGMENT.test(part) || part === '.' || part === '..')) {
    packageFailure('PACKAGE_PATH_INVALID', 'Package path escapes its package boundary.');
  }
}

function decodeFile(file) {
  assertExactKeys(file, FILE_FIELDS, 'Package file');
  validatePath(file.path);
  if (RESERVED_PACKAGE_PATHS.includes(file.path)) {
    packageFailure('PACKAGE_PATH_RESERVED', 'Package file path is reserved by the package store.');
  }
  if (typeof file.mediaType !== 'string' || !SAFE_MEDIA_TYPE.test(file.mediaType)) {
    packageFailure('PACKAGE_FILE_INVALID', 'Package file media type is invalid.');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0
    || file.size > PACKAGE_LIMITS.maxFileBytes) {
    packageFailure('PACKAGE_FILE_INVALID', 'Package file size is outside the local limit.');
  }
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
    packageFailure('PACKAGE_FILE_INVALID', 'Package file SHA-256 is invalid.');
  }
  if (typeof file.content !== 'string' || !BASE64.test(file.content)
    || Buffer.from(file.content, 'base64').toString('base64') !== file.content) {
    packageFailure('PACKAGE_FILE_INVALID', 'Package file content must use canonical base64.');
  }
  const content = Buffer.from(file.content, 'base64');
  if (content.length !== file.size || sha256(content) !== file.sha256) {
    packageFailure(
      'PACKAGE_FILE_INTEGRITY_FAILED',
      'Package file size or digest does not match its inventory.',
    );
  }
  return { ...file, content };
}

function validateManifestIdentity(manifest) {
  if (!PLUGIN_ID.test(manifest.id) || typeof manifest.name !== 'string'
    || !manifest.name.trim() || !SEMVER.test(manifest.version)) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin identity is invalid.');
  }
  if (!['manual', 'on-capability'].includes(manifest.activation)) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin activation is invalid.');
  }
  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.length
    || manifest.capabilities.some(
      (item) => typeof item !== 'string' || !CAPABILITY_ID.test(item),
    ) || new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin capabilities are invalid.');
  }
  if (!Array.isArray(manifest.permissions)) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin permissions must be an array.');
  }
  const permissionNames = new Set();
  for (const permission of manifest.permissions) {
    if (!isPlainObject(permission) || Object.keys(permission).sort().join(',') !== 'name,reason'
      || !LOCAL_PERMISSIONS.includes(permission.name) || typeof permission.reason !== 'string'
      || permission.reason.trim().length < 8 || permissionNames.has(permission.name)) {
      packageFailure(
        'PACKAGE_PERMISSION_FORBIDDEN',
        'Plugin package requests a forbidden, duplicate, or malformed permission.',
      );
    }
    permissionNames.add(permission.name);
  }
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.some(
    (dependency) => !isPlainObject(dependency)
      || Object.keys(dependency).sort().join(',') !== 'digest,id,version'
      || !PLUGIN_ID.test(dependency.id) || !SEMVER.test(dependency.version)
      || !SHA256.test(dependency.digest) || dependency.id === manifest.id,
  ) || new Set(manifest.dependencies.map((dependency) => dependency.id)).size
    !== manifest.dependencies.length) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin dependencies are invalid.');
  }
}

function validateManifest(manifest, paths) {
  if (!isPlainObject(manifest) || ![2, 3].includes(manifest.manifestVersion)) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin manifest version is unsupported.');
  }
  assertExactKeys(
    manifest,
    manifest.manifestVersion === 2 ? MANIFEST_V2_FIELDS : MANIFEST_V3_FIELDS,
    'Plugin manifest',
  );
  if (manifest.protocolVersion !== 1) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin protocol version is unsupported.');
  }
  validateManifestIdentity(manifest);
  validatePath(manifest.entry);
  const executable = manifest.manifestVersion === 3;
  const requiredExtension = executable ? '.js' : '.mjs';
  if (!manifest.entry.endsWith(requiredExtension) || !paths.has(manifest.entry)) {
    packageFailure(
      'PACKAGE_MANIFEST_INVALID',
      `Plugin entry must be an included ${requiredExtension} file.`,
    );
  }
  if (!executable) return;
  assertExactKeys(manifest.runtime, RUNTIME_FIELDS, 'Plugin runtime');
  if (manifest.runtime.kind !== JAVASCRIPTCORE_CLASSIC_RUNTIME.kind
    || manifest.runtime.apiVersion !== JAVASCRIPTCORE_CLASSIC_RUNTIME.apiVersion) {
    packageFailure(
      'PACKAGE_RUNTIME_INVALID',
      'Plugin runtime must be the supported JavaScriptCore classic-script API.',
    );
  }
  if (manifest.dependencies.length !== 0) {
    packageFailure(
      'PACKAGE_RUNTIME_DEPENDENCIES_DISABLED',
      'Executable JavaScriptCore plugin dependencies are disabled.',
      409,
    );
  }
}

function sourceWithoutCommentsAndLiterals(source) {
  let output = '';
  let index = 0;
  let quote = null;
  let templateDepth = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (character === '\\') {
        output += '  ';
        index += 2;
        continue;
      }
      if (quote === '`' && character === '$' && next === '{') {
        output += '  ';
        templateDepth += 1;
        index += 2;
        quote = null;
        continue;
      }
      if (character === quote) quote = null;
      output += ' ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const length = (end === -1 ? source.length : end) - index;
      output += ' '.repeat(length);
      index += length;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const length = (end === -1 ? source.length : end + 2) - index;
      output += ' '.repeat(length);
      index += length;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      output += ' ';
      index += 1;
      continue;
    }
    output += character;
    if (templateDepth && character === '}') {
      templateDepth -= 1;
      if (templateDepth === 0) quote = '`';
    }
    index += 1;
  }
  return output;
}

function validateClassicScriptSources(decodedFiles, manifest) {
  if (manifest.manifestVersion !== 3) return null;
  if (decodedFiles.some((file) => file.path.endsWith('.mjs'))) {
    packageFailure(
      'PACKAGE_RUNTIME_INVALID',
      'Executable JavaScriptCore packages may not contain .mjs files.',
    );
  }
  const entry = decodedFiles.find((file) => file.path === manifest.entry);
  if (!entry || !JAVASCRIPT_MEDIA_TYPES.includes(entry.mediaType)) {
    packageFailure(
      'PACKAGE_MANIFEST_INVALID',
      'Plugin entry must declare a JavaScript media type.',
    );
  }
  for (const file of decodedFiles) {
    if (!file.path.endsWith('.js')) continue;
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
    } catch {
      packageFailure(
        'PACKAGE_RUNTIME_INVALID',
        'Executable JavaScriptCore source must be valid UTF-8.',
      );
    }
    if (/\b(?:import|export)\b/.test(sourceWithoutCommentsAndLiterals(source))) {
      packageFailure(
        'PACKAGE_RUNTIME_MODULE_SYNTAX',
        'Executable JavaScriptCore source may not use module import or export syntax.',
      );
    }
  }
  return Object.freeze({
    kind: JAVASCRIPTCORE_CLASSIC_RUNTIME.kind,
    apiVersion: JAVASCRIPTCORE_CLASSIC_RUNTIME.apiVersion,
    entry: entry.path,
    sha256: entry.sha256,
  });
}

export function validatePluginPackageManifest(pluginPackage) {
  if (pluginPackage.packageVersion !== 1 || !Array.isArray(pluginPackage.files)
    || !pluginPackage.files.length || pluginPackage.files.length > PACKAGE_LIMITS.maxFiles) {
    packageFailure('PACKAGE_INVALID', 'Plugin package inventory is invalid.');
  }
  const decodedFiles = pluginPackage.files.map(decodeFile);
  if (decodedFiles.reduce((total, file) => total + file.size, 0)
    > PACKAGE_LIMITS.maxTotalBytes) {
    packageFailure(
      'PACKAGE_TOO_LARGE',
      'Plugin package decoded content exceeds the local limit.',
      413,
    );
  }
  const paths = new Set();
  const foldedPaths = new Set();
  for (const file of decodedFiles) {
    const foldedPath = file.path.toLocaleLowerCase('en-US');
    if (paths.has(file.path) || foldedPaths.has(foldedPath)) {
      packageFailure(
        'PACKAGE_PATH_COLLISION',
        'Package file paths collide after case normalization.',
      );
    }
    paths.add(file.path);
    foldedPaths.add(foldedPath);
  }
  validateManifest(pluginPackage.manifest, paths);
  const entryFile = decodedFiles.find((file) => file.path === pluginPackage.manifest.entry);
  if (!entryFile || !JAVASCRIPT_MEDIA_TYPES.includes(entryFile.mediaType)) {
    packageFailure(
      'PACKAGE_MANIFEST_INVALID',
      'Plugin entry must declare a JavaScript media type.',
    );
  }
  return Object.freeze({
    decodedFiles,
    executableRuntime: validateClassicScriptSources(decodedFiles, pluginPackage.manifest),
  });
}
