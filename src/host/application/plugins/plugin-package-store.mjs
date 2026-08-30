import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../../platform/runtime/host-error.mjs';
import { PluginPackageInstallationIntegrity } from './plugin-package-installation-integrity.mjs';
import { verifyPluginPackage } from './plugin-package.mjs';
import { PluginPackageRegistry } from './plugin-package-registry.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function compareVersion(a, b) {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
export class PluginPackageStore {
  #root; #trustedPublishers; #installations; #administrationPolicy; #registry; #initialized = false;
  constructor({ root, trustedPublishers, administrationPolicy = null }) {
    if (typeof root !== 'string' || !root) throw new TypeError('Plugin package store root is required.');
    if (administrationPolicy !== null
      && typeof administrationPolicy?.authorizePluginPackageMutation !== 'function') {
      throw new TypeError('administrationPolicy must expose authorizePluginPackageMutation.');
    }
    this.#root = root; this.#trustedPublishers = trustedPublishers;
    this.#administrationPolicy = administrationPolicy;
    this.#installations = new PluginPackageInstallationIntegrity({ root, trustedPublishers });
    this.#registry = new PluginPackageRegistry({ root });
  }
  get root() { return this.#root; }
  async initialize() {
    if (this.#initialized) return this;
    await mkdir(join(this.#root, 'packages'), { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700); await chmod(join(this.#root, 'packages'), 0o700);
    await this.#registry.load();
    for (const [id, plugin] of Object.entries(this.#registry.value.plugins)) for (const [version, record] of Object.entries(plugin.versions)) await this.#verifyRegistered(id, version, record.digest);
    this.#initialized = true; return this;
  }
  async install(input) {
    this.#assertReady(); await this.#authorizeAdministration('install'); return this.#registry.update(async () => {
      const verified = verifyPluginPackage(input, this.#trustedPublishers);
      await this.#installations.ensureInstallation(verified);
      await this.#installations.verifyInstallation(verified.digest);
      const nextRegistry = structuredClone(this.#registry.value);
      const plugin = this.#registry.plugin(nextRegistry, verified.manifest.id);
      const existing = plugin.versions[verified.manifest.version];
      if (existing && existing.digest !== verified.digest) fail('PACKAGE_VERSION_CONFLICT', 'A different package is already installed for this plugin ID and version.', 409);
      plugin.versions[verified.manifest.version] = { digest: verified.digest, installedAt: new Date().toISOString() };
      await this.#registry.commit(nextRegistry);
      return Object.freeze({ id: verified.manifest.id, version: verified.manifest.version, digest: verified.digest });
    });
  }
  async select(id, version) {
    this.#assertReady(); await this.#authorizeAdministration('select'); return this.#registry.update(async () => {
      const plugin = this.#existingPlugin(id); const next = plugin.versions[version];
      if (!next) fail('PACKAGE_NOT_INSTALLED', 'Plugin version is not installed.', 404);
      if (plugin.selected && compareVersion(version, plugin.selected.version) < 0) fail('PACKAGE_DOWNGRADE_REJECTED', 'Selecting an older version requires the controlled rollback operation.', 409);
      await this.#verifyRegistered(id, version, next.digest);
      if (plugin.selected?.version !== version) {
        const nextRegistry = structuredClone(this.#registry.value);
        const nextPlugin = this.#registry.existingPlugin(id, nextRegistry);
        nextPlugin.previousSelected = nextPlugin.selected;
        nextPlugin.selected = { version, digest: next.digest };
        await this.#commitSelection(nextRegistry);
      }
      return this.#getSelectedPackage(id);
    });
  }
  async restorePreviousSelection(id) {
    this.#assertReady(); await this.#authorizeAdministration('rollback'); return this.#registry.update(async () => {
      const plugin = this.#existingPlugin(id);
      if (!plugin.selected || !plugin.previousSelected) fail('PACKAGE_ROLLBACK_UNAVAILABLE', 'No previous selected plugin version is available for rollback.', 409);
      const prior = plugin.previousSelected; await this.#verifyRegistered(id, prior.version, prior.digest);
      const nextRegistry = structuredClone(this.#registry.value);
      const nextPlugin = this.#registry.existingPlugin(id, nextRegistry);
      nextPlugin.previousSelected = nextPlugin.selected;
      nextPlugin.selected = structuredClone(prior);
      await this.#commitSelection(nextRegistry);
      return this.#getSelectedPackage(id);
    });
  }
  async getSelectedPackage(id) { this.#assertReady(); return this.#getSelectedPackage(id); }
  async #getSelectedPackage(id) {
    const plugin = this.#existingPlugin(id);
    if (!plugin.selected) fail('PACKAGE_NOT_SELECTED', 'Plugin has no selected version.', 404);
    const selected = structuredClone(plugin.selected);
    const verified = await this.#verifyRegistered(id, selected.version, selected.digest);
    this.#assertStillSelected(id, selected);
    return Object.freeze({ id: verified.manifest.id, version: verified.manifest.version, digest: verified.digest, manifest: verified.manifest, publisher: verified.publisher });
  }
  listPlugins() {
    this.#assertReady();
    return Object.freeze(Object.entries(this.#registry.value.plugins).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([id]) => this.getPlugin(id)));
  }
  getPlugin(id) {
    this.#assertReady(); const plugin = this.#existingPlugin(id);
    return Object.freeze({
      id, selectedVersion: plugin.selected?.version ?? null, previousSelectedVersion: plugin.previousSelected?.version ?? null,
      versions: Object.freeze(Object.entries(plugin.versions).sort(([left], [right]) => compareVersion(left, right)).map(([version, record]) => Object.freeze({ version, digest: record.digest }))),
    });
  }
  async #authorizeAdministration(action) {
    if (this.#administrationPolicy) {
      await this.#administrationPolicy.authorizePluginPackageMutation(action);
    }
  }
  async #verifyRegistered(id, version, digest) {
    const verified = await this.#installations.verifyInstallation(digest);
    if (verified.manifest.id !== id || verified.manifest.version !== version || verified.digest !== digest) fail('PACKAGE_REGISTRY_MISMATCH', 'Plugin registry does not match its signed package.', 500);
    return verified;
  }
  #existingPlugin(id, registry = this.#registry.value) { return this.#registry.existingPlugin(id, registry); }
  #assertStillSelected(id, expected) {
    const current = this.#existingPlugin(id).selected;
    if (!current || current.version !== expected.version || current.digest !== expected.digest) {
      fail('PACKAGE_SELECTION_CHANGED', 'The selected plugin package changed during verification.', 409);
    }
  }
  async #commitSelection(nextRegistry) {
    await this.#registry.commit(nextRegistry);
  }
  #assertReady() { if (!this.#initialized) fail('PACKAGE_STORE_UNINITIALIZED', 'Plugin package store is not initialized.', 503); }
}
