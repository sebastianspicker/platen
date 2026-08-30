import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../../platform/runtime/host-error.mjs';
import { canonicalizePluginPackage, parsePluginPackage } from './plugin-package-codec.mjs';
import { verifyPluginPackage } from './plugin-package.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

/** Persists signed metadata as one canonical JSON record, never as an executable package tree. */
export class PluginPackageInstallationIntegrity {
  #root; #trustedPublishers;
  constructor({ root, trustedPublishers }) { this.#root = root; this.#trustedPublishers = trustedPublishers; }
  packagePath(digest) { return join(this.#root, 'packages', `${digest}.json`); }

  async ensureInstallation(verified) {
    const target = this.packagePath(verified.digest);
    try {
      const existing = await this.verifyInstallation(verified.digest);
      if (existing.digest !== verified.digest) fail('PACKAGE_STORE_DIGEST_MISMATCH', 'Installed metadata digest is inconsistent.', 500);
      return target;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.#writeInstallation(target, verified);
    return target;
  }

  async verifyInstallation(digest) {
    const target = this.packagePath(digest);
    const metadata = await stat(target);
    if (!metadata.isFile() || (metadata.mode & 0o111) !== 0 || (metadata.mode & 0o077) !== 0) {
      fail('PACKAGE_STORE_INVALID_METADATA', 'Installed plugin metadata has unsafe permissions.', 500);
    }
    const bytes = await readFile(target);
    const parsed = parsePluginPackage(bytes);
    if (canonicalizePluginPackage(parsed) !== bytes.toString('utf8')) {
      fail('PACKAGE_STORE_NONCANONICAL', 'Installed plugin metadata is not canonical.', 500);
    }
    const verified = verifyPluginPackage(parsed, this.#trustedPublishers);
    if (verified.digest !== digest) fail('PACKAGE_STORE_DIGEST_MISMATCH', 'Installed plugin metadata digest does not match its registry key.', 500);
    return verified;
  }

  async #writeInstallation(target, verified) {
    const packages = join(this.#root, 'packages');
    await mkdir(packages, { recursive: true, mode: 0o700 });
    await chmod(packages, 0o700);
    const contents = canonicalizePluginPackage({
      packageVersion: 1,
      manifest: verified.manifest,
      signature: verified.signature,
    });
    const temporary = join(packages, `${verified.digest}-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
