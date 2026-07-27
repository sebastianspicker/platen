import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagePath = join(root, 'native/plugin-worker');
const worker = join(packagePath, '.build/debug/PDFPluginWorker');
const supervisor = join(packagePath, '.build/debug/PDFPluginSupervisor');

function run(executable, args = [], input = '', { privateRpc = false } = {}) {
  return spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout: 5_000,
    stdio: privateRpc ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : undefined,
  });
}

test.before(() => {
  const result = run('/usr/bin/env', ['swift', 'build', '--disable-sandbox', '--package-path', packagePath]);
  assert.equal(result.status, 0, result.stderr);
});

test('native plugin worker package has strict source and entitlement artifacts', () => {
  assert.equal(existsSync(join(packagePath, 'Package.swift')), true);
  for (const name of ['PDFPluginWorker.entitlements', 'PDFPluginSupervisor.entitlements']) {
    const result = run('/usr/bin/plutil', ['-lint', join(packagePath, 'Entitlements', name)]);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('native worker applies quotas before JavaScriptCore and fails closed when the host rejects an address-space hard limit', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(existsSync(worker), true, 'build native/plugin-worker before this integration probe');
  const result = run(worker, ['--self-test']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^PLUGIN_RLIMIT_FAILED\n$/u);
});

test('normal supervisor never reports ready for an unsigned SwiftPM worker', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(existsSync(supervisor), true, 'build native/plugin-worker before this integration probe');
  const source = 'x';
  const bootstrap = `{"packageHash":"${'a'.repeat(64)}","pluginId":"org.platen.example","sourceBytes":1,"sourceSha256":"${createHash('sha256').update(source).digest('hex')}","version":"1.0.0"}\n`;
  const result = run(supervisor, [], bootstrap + source, { privateRpc: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^PLUGIN_(?:TEAM_IDENTIFIER_INVALID|STATIC_IDENTITY_INVALID)\n$/u);
});
