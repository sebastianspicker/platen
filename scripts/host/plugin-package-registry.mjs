import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REGISTRY_FIELDS = new Set(['schemaVersion', 'plugins']);
const REGISTRY_PLUGIN_FIELDS = new Set(['versions', 'active', 'previous']);
const VERSION_RECORD_FIELDS = new Set(['digest', 'installedAt']);
const ACTIVE_RECORD_FIELDS = new Set(['version', 'digest']);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function assertExactKeys(value, expected) {
  if (!isPlainObject(value) || Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry contains an invalid object.', 500);
}

export class PluginPackageRegistry {
  #root; #value = { schemaVersion: 1, plugins: {} }; #loaded = false; #mutation = Promise.resolve();
  constructor({ root }) {
    if (typeof root !== 'string' || !root) throw new TypeError('Plugin package registry root is required.');
    this.#root = root;
  }
  get value() { this.#assertLoaded(); return this.#value; }
  async load() {
    if (this.#loaded) return this;
    try { this.#value = JSON.parse(await readFile(join(this.#root, 'registry.json'), 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry is not valid JSON.', 500); }
    this.validate(this.#value);
    this.#loaded = true;
    return this;
  }
  validate(registry = this.#value) {
    assertExactKeys(registry, REGISTRY_FIELDS);
    if (registry.schemaVersion !== 1 || !isPlainObject(registry.plugins)) fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry is invalid.', 500);
    for (const [id, plugin] of Object.entries(registry.plugins)) {
      if (!PLUGIN_ID.test(id)) fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry contains an invalid plugin ID.', 500);
      assertExactKeys(plugin, REGISTRY_PLUGIN_FIELDS);
      if (!isPlainObject(plugin.versions)) fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry versions are invalid.', 500);
      for (const [version, record] of Object.entries(plugin.versions)) {
        if (!SEMVER.test(version)) fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry contains an invalid version.', 500);
        assertExactKeys(record, VERSION_RECORD_FIELDS);
        if (!DIGEST.test(record.digest) || typeof record.installedAt !== 'string' || Number.isNaN(Date.parse(record.installedAt))) fail('PACKAGE_REGISTRY_INVALID', 'Plugin registry version metadata is invalid.', 500);
      }
      for (const current of [plugin.active, plugin.previous]) {
        if (current === null) continue;
        assertExactKeys(current, ACTIVE_RECORD_FIELDS);
        if (!SEMVER.test(current.version) || !DIGEST.test(current.digest) || plugin.versions[current.version]?.digest !== current.digest) fail('PACKAGE_REGISTRY_MISMATCH', 'Plugin registry active state does not match installed versions.', 500);
      }
    }
  }
  plugin(registry, id) {
    if (!PLUGIN_ID.test(id)) fail('PACKAGE_PLUGIN_INVALID', 'Plugin ID is invalid.');
    return registry.plugins[id] ??= { versions: {}, active: null, previous: null };
  }
  existingPlugin(id, registry = this.#value) {
    if (!PLUGIN_ID.test(id)) fail('PACKAGE_PLUGIN_INVALID', 'Plugin ID is invalid.');
    const plugin = registry.plugins[id];
    if (!plugin) fail('PACKAGE_NOT_INSTALLED', 'Plugin is not installed.', 404);
    return plugin;
  }
  async commit(nextRegistry) {
    this.#assertLoaded();
    this.validate(nextRegistry);
    const temporary = join(this.#root, `registry-${process.pid}-${randomUUID()}.tmp`);
    try {
      await this.#writeDurable(temporary, JSON.stringify(nextRegistry), 0o600, 'wx');
      await rename(temporary, join(this.#root, 'registry.json'));
      await this.#syncDirectory(this.#root);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    this.#value = nextRegistry;
  }
  async update(work) {
    this.#assertLoaded();
    if (typeof work !== 'function') throw new TypeError('registry update must be callable');
    const prior = this.#mutation; let release;
    this.#mutation = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }
  #assertLoaded() { if (!this.#loaded) fail('PACKAGE_REGISTRY_UNINITIALIZED', 'Plugin package registry is not initialized.', 503); }
  async #writeDurable(path, contents, mode, flag = 'w') { const handle = await open(path, flag, mode); try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); } }
  async #syncDirectory(path) { try { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error; } }
}
