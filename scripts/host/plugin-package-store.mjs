import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { resolvePinnedDependencyDag } from './plugin-package-dependencies.mjs';
import { PluginPackageInstallationIntegrity, safePackageChild } from './plugin-package-installation-integrity.mjs';
import { verifyPluginPackage } from './plugin-package.mjs';
import { PluginPackageRegistry } from './plugin-package-registry.mjs';

export { resolvePinnedDependencyDag } from './plugin-package-dependencies.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function compareVersion(a, b) {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
export class PluginPackageStore {
  #root; #trustedPublishers; #installations; #activationTransition; #registry; #initialized = false;
  constructor({ root, trustedPublishers, activationTransition = async ({ commit }) => commit() }) {
    if (typeof root !== 'string' || !root) throw new TypeError('Plugin package store root is required.');
    if (typeof activationTransition !== 'function') throw new TypeError('activationTransition must be callable.');
    this.#root = root; this.#trustedPublishers = trustedPublishers;
    this.#activationTransition = activationTransition;
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
    this.#assertReady(); return this.#registry.update(async () => {
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
  async activate(id, version) {
    this.#assertReady(); return this.#registry.update(async () => {
      const plugin = this.#existingPlugin(id); const next = plugin.versions[version];
      if (!next) fail('PACKAGE_NOT_INSTALLED', 'Plugin version is not installed.', 404);
      if (plugin.active && compareVersion(version, plugin.active.version) < 0) fail('PACKAGE_DOWNGRADE_REJECTED', 'Downgrades require the controlled rollback operation.', 409);
      await this.#verifyRegistered(id, version, next.digest);
      await this.#resolveDependencies(id, version, next.digest);
      if (plugin.active?.version !== version) {
        const nextRegistry = structuredClone(this.#registry.value);
        const nextPlugin = this.#registry.existingPlugin(id, nextRegistry);
        const previous = structuredClone(nextPlugin.active);
        nextPlugin.previous = nextPlugin.active;
        nextPlugin.active = { version, digest: next.digest };
        await this.#commitActivation(nextRegistry, { id, previous, next: nextPlugin.active, reason: 'activation' });
      }
      return this.#getActivation(id);
    });
  }
  async rollback(id) {
    this.#assertReady(); return this.#registry.update(async () => {
      const plugin = this.#existingPlugin(id);
      if (!plugin.active || !plugin.previous) fail('PACKAGE_ROLLBACK_UNAVAILABLE', 'No previous plugin version is available for rollback.', 409);
      const prior = plugin.previous; await this.#verifyRegistered(id, prior.version, prior.digest);
      await this.#resolveDependencies(id, prior.version, prior.digest);
      const nextRegistry = structuredClone(this.#registry.value);
      const nextPlugin = this.#registry.existingPlugin(id, nextRegistry);
      const previous = structuredClone(nextPlugin.active);
      nextPlugin.previous = nextPlugin.active;
      nextPlugin.active = structuredClone(prior);
      await this.#commitActivation(nextRegistry, { id, previous, next: nextPlugin.active, reason: 'rollback' });
      return this.#getActivation(id);
    });
  }
  async getActivation(id) { this.#assertReady(); return this.#getActivation(id); }
  async getLaunchDescriptor(id) {
    this.#assertReady();
    const plugin = this.#existingPlugin(id);
    if (!plugin.active) fail('PACKAGE_NOT_ACTIVE', 'Plugin has no active version.', 404);
    const active = structuredClone(plugin.active);
    const dependencies = await this.#resolveDependencies(id, active.version, active.digest);
    const verified = await this.#verifyRegistered(id, active.version, active.digest);
    this.#assertStillActive(id, active);
    const packageRoot = this.#installations.packagePath(verified.digest);
    return Object.freeze({
      id: verified.manifest.id, version: verified.manifest.version, digest: verified.digest, packageHash: verified.digest,
      manifest: verified.manifest, publisher: verified.publisher, packageRoot,
      entryPath: safePackageChild(packageRoot, verified.manifest.entry), inventory: verified.files, dependencies,
      executableRuntime: verified.executableRuntime,
    });
  }
  async getExecutableLaunch(id) {
    const descriptor = await this.getLaunchDescriptor(id);
    if (!descriptor.executableRuntime) fail('PACKAGE_RUNTIME_NOT_EXECUTABLE', 'The active package has no supported executable runtime.', 409);
    const verified = await this.#verifyRegistered(id, descriptor.version, descriptor.digest);
    const runtime = verified.executableRuntime;
    if (!runtime || runtime.kind !== descriptor.executableRuntime.kind
      || runtime.apiVersion !== descriptor.executableRuntime.apiVersion
      || runtime.entry !== descriptor.executableRuntime.entry
      || runtime.sha256 !== descriptor.executableRuntime.sha256) {
      fail('PACKAGE_RUNTIME_MISMATCH', 'The active package runtime changed before launch.', 409);
    }
    this.#assertStillActive(id, { version: descriptor.version, digest: descriptor.digest });
    return Object.freeze({ descriptor, source: verified.getContent(runtime.entry) });
  }
  async #getActivation(id) {
    const plugin = this.#existingPlugin(id);
    if (!plugin.active) fail('PACKAGE_NOT_ACTIVE', 'Plugin has no active version.', 404);
    const active = structuredClone(plugin.active);
    const dependencies = await this.#resolveDependencies(id, active.version, active.digest);
    // The dependency walk can take observable time. Rehash the active package last so
    // the host-only descriptor always describes bytes verified immediately before use.
    const verified = await this.#verifyRegistered(id, active.version, active.digest);
    this.#assertStillActive(id, active);
    return Object.freeze({ id: verified.manifest.id, version: verified.manifest.version, digest: verified.digest, manifest: verified.manifest, publisher: verified.publisher, dependencies });
  }
  listPlugins() {
    this.#assertReady();
    return Object.freeze(Object.entries(this.#registry.value.plugins).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([id]) => this.getPlugin(id)));
  }
  getPlugin(id) {
    this.#assertReady(); const plugin = this.#existingPlugin(id);
    return Object.freeze({
      id, activeVersion: plugin.active?.version ?? null, previousVersion: plugin.previous?.version ?? null,
      versions: Object.freeze(Object.entries(plugin.versions).sort(([left], [right]) => compareVersion(left, right)).map(([version, record]) => Object.freeze({ version, digest: record.digest }))),
    });
  }
  async #verifyRegistered(id, version, digest) {
    const verified = await this.#installations.verifyInstallation(digest);
    if (verified.manifest.id !== id || verified.manifest.version !== version || verified.digest !== digest) fail('PACKAGE_REGISTRY_MISMATCH', 'Plugin registry does not match its signed package.', 500);
    return verified;
  }
  async #resolveDependencies(id, version, digest) {
    return resolvePinnedDependencyDag({ id, version, digest }, async (request) => {
      const plugin = this.#registry.value.plugins[request.id]; const record = plugin?.versions?.[request.version];
      if (!record) return null;
      return this.#verifyRegistered(request.id, request.version, record.digest);
    });
  }
  #existingPlugin(id, registry = this.#registry.value) { return this.#registry.existingPlugin(id, registry); }
  #assertStillActive(id, expected) {
    const current = this.#existingPlugin(id).active;
    if (!current || current.version !== expected.version || current.digest !== expected.digest) {
      fail('PACKAGE_ACTIVE_CHANGED', 'The active plugin package changed during verification.', 409);
    }
  }
  async #commitActivation(nextRegistry, transition) {
    let open = true; let committed = false; let commitPromise = null; let transitionError = null;
    const commit = async () => {
      if (!open || commitPromise) fail('PACKAGE_TRANSITION_INVALID', 'Plugin activation transition attempted an invalid commit.', 500);
      commitPromise = (async () => {
        await this.#registry.commit(nextRegistry);
        committed = true;
      })();
      return commitPromise;
    };
    try {
      await this.#activationTransition(Object.freeze({
        id: transition.id,
        previous: transition.previous && Object.freeze({ ...transition.previous }),
        next: Object.freeze({ ...transition.next }),
        reason: transition.reason,
        commit,
      }));
    } catch (error) { transitionError = error; }
    finally { open = false; }
    if (commitPromise) {
      try { await commitPromise; } catch (commitError) {
        if (transitionError) {
          throw new HostError('PACKAGE_TRANSITION_COMMIT_FAILED', 'Plugin activation transition could not commit durable state.', 500, {
            cause: new AggregateError([transitionError, commitError], 'Plugin transition and durable commit failed.'),
          });
        }
        throw commitError;
      }
    }
    // Durable registry state is authoritative. A transition hook must perform
    // all fallible work before commit; an error after a successful commit cannot
    // truthfully be returned to the caller as an activation failure.
    if (committed) return;
    if (transitionError) throw transitionError;
    if (!committed) fail('PACKAGE_TRANSITION_INCOMPLETE', 'Plugin activation transition did not commit.', 500);
  }
  #assertReady() { if (!this.#initialized) fail('PACKAGE_STORE_UNINITIALIZED', 'Plugin package store is not initialized.', 503); }
}
