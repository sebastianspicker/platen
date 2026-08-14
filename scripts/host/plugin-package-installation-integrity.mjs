import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { HostError } from './host-error.mjs';
import { sha256 } from './plugin-package-codec.mjs';
import { PACKAGE_LIMITS } from './plugin-package-contract.mjs';
import { verifyPluginPackage } from './plugin-package.mjs';

const INSTALLATION_DESCRIPTOR_FIELDS = new Set(['digest', 'manifest', 'publisher', 'signature', 'files']);
const INSTALLATION_PUBLISHER_FIELDS = new Set(['publisherId', 'keyId']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sameFileIdentity(left, right) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((field) => left[field] === right[field]);
}

export function safePackageChild(parent, child) {
  const target = join(parent, child); const value = relative(parent, target);
  if (value === '' || value.startsWith(`..${sep}`) || value === '..') fail('PACKAGE_STORE_INVALID_PATH', 'Refusing a package path outside the store.', 500);
  return target;
}

export class PluginPackageInstallationIntegrity {
  #root; #trustedPublishers;
  constructor({ root, trustedPublishers }) { this.#root = root; this.#trustedPublishers = trustedPublishers; }
  packagePath(digest) { return safePackageChild(join(this.#root, 'packages'), digest); }
  async ensureInstallation(verified) {
    const target = this.packagePath(verified.digest);
    try { await stat(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; await this.#writeInstallation(target, verified); }
    return target;
  }
  async verifyInstallation(digest) {
    const root = this.packagePath(digest); let rootHandle;
    try {
      try { rootHandle = await this.#openStableDirectory(root); } catch (error) { if (error instanceof HostError) throw error; fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package root is missing.', 500); }
      const rootBefore = await rootHandle.stat({ bigint: true });
      const descriptorPath = join(root, 'package.json'); let descriptor;
      try { descriptor = JSON.parse(await this.#readStableUtf8File(descriptorPath, PACKAGE_LIMITS.maxEncodedBytes)); } catch (error) { if (error instanceof HostError) throw error; fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package metadata is missing or invalid.', 500); }
      if (!isPlainObject(descriptor) || Object.keys(descriptor).length !== INSTALLATION_DESCRIPTOR_FIELDS.size || Object.keys(descriptor).some((key) => !INSTALLATION_DESCRIPTOR_FIELDS.has(key)) || !isPlainObject(descriptor.publisher) || Object.keys(descriptor.publisher).length !== INSTALLATION_PUBLISHER_FIELDS.size || Object.keys(descriptor.publisher).some((key) => !INSTALLATION_PUBLISHER_FIELDS.has(key)) || descriptor.digest !== digest || !Array.isArray(descriptor.files) || descriptor.files.some((file) => !file || typeof file.path !== 'string' || file.path === 'package.json')) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package metadata does not match its address.', 500);
      this.#assertBoundedInventory(descriptor.files);
      const expected = new Set(descriptor.files.map((file) => file.path)); expected.add('package.json');
      const actual = new Set(await this.#installedRegularFiles(root));
      if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin tree contains unsigned or non-regular entries.', 500);
      const files = [];
      for (const file of descriptor.files) {
        const path = safePackageChild(root, file.path); let bytes;
        try { bytes = await this.#readStableRegularFile(path, file.size); } catch { fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin content is missing.', 500); }
        if (bytes.length !== file.size || sha256(bytes) !== file.sha256) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin content no longer matches its signed inventory.', 500);
        files.push({ ...file, content: bytes.toString('base64') });
      }
      const verified = verifyPluginPackage({ packageVersion: 1, manifest: descriptor.manifest, files, signature: descriptor.signature }, this.#trustedPublishers);
      const rootAfter = await rootHandle.stat({ bigint: true });
      const currentRoot = await this.#directoryIdentity(root);
      if (verified.digest !== digest || descriptor.publisher.publisherId !== verified.publisher.publisherId || descriptor.publisher.keyId !== verified.publisher.keyId || !sameFileIdentity(rootBefore, rootAfter) || !sameFileIdentity(rootBefore, currentRoot)) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package address no longer matches its signed package.', 500);
      return verified;
    } finally { await rootHandle?.close(); }
  }
  async #writeInstallation(target, verified) {
    const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      for (const file of verified.files) {
        const output = safePackageChild(staging, file.path); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await this.#writeDurable(output, verified.getContent(file.path), 0o400); await chmod(output, 0o400);
      }
      await this.#writeDurable(join(staging, 'package.json'), JSON.stringify({ digest: verified.digest, manifest: verified.manifest, publisher: verified.publisher, signature: verified.signature, files: verified.files }, null, 2), 0o400);
      await chmod(join(staging, 'package.json'), 0o400); await this.#chmodTree(staging); for (const directory of await this.#walk(staging, true)) await this.#syncDirectory(directory); await rename(staging, target); await this.#syncDirectory(dirname(target));
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  async #chmodTree(root) {
    for (const file of await this.#walk(root)) await chmod(file, 0o400);
    for (const directory of (await this.#walk(root, true)).reverse()) await chmod(directory, 0o500);
  }
  async #walk(root, directories = false) {
    const entries = await readdir(root, { withFileTypes: true }); const values = directories ? [root] : [];
    for (const entry of entries) { const path = join(root, entry.name); if (entry.isDirectory()) values.push(...await this.#walk(path, directories)); else if (!directories) values.push(path); }
    return values;
  }
  async #installedRegularFiles(root, prefix = '') {
    const paths = [];
    const directory = prefix ? safePackageChild(root, prefix) : root;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = safePackageChild(root, relativePath);
      if (entry.isDirectory()) {
        const directory = await this.#openStableDirectory(path);
        const before = await directory.stat({ bigint: true });
        try {
          paths.push(...await this.#installedRegularFiles(root, relativePath));
          if (!sameFileIdentity(before, await directory.stat({ bigint: true })) || !sameFileIdentity(before, await this.#directoryIdentity(path))) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package directory changed while being read.', 500);
        } finally { await directory.close(); }
      } else if (entry.isFile()) {
        await this.#readStableRegularFile(path, PACKAGE_LIMITS.maxFileBytes);
        paths.push(relativePath);
      }
      else fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin tree contains an unsigned or non-regular entry.', 500);
    }
    return paths;
  }
  #assertBoundedInventory(files) {
    if (!Array.isArray(files) || files.length === 0 || files.length > PACKAGE_LIMITS.maxFiles) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package metadata has an invalid inventory.', 500);
    let total = 0;
    for (const file of files) {
      if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > PACKAGE_LIMITS.maxFileBytes) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package metadata has an invalid inventory.', 500);
      total += file.size;
      if (total > PACKAGE_LIMITS.maxTotalBytes) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package metadata has an invalid inventory.', 500);
    }
  }
  async #readStableUtf8File(path, maximumBytes) { return UTF8.decode(await this.#readStableRegularFile(path, maximumBytes)); }
  async #openStableDirectory(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isDirectory()) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package root is not a directory.', 500);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async #directoryIdentity(path) {
    const handle = await this.#openStableDirectory(path);
    try { return await handle.stat({ bigint: true }); } finally { await handle.close(); }
  }
  async #readStableRegularFile(path, maximumBytes) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package file is not a single-link regular file within local limits.', 500);
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package file changed while being read.', 500);
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (!sameFileIdentity(before, after)) fail('PACKAGE_INTEGRITY_FAILED', 'Installed plugin package file changed while being read.', 500);
      return bytes;
    } finally { await handle?.close(); }
  }
  async #writeDurable(path, contents, mode, flag = 'w') { const handle = await open(path, flag, mode); try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); } }
  async #syncDirectory(path) { try { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error; } }
}
