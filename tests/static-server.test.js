import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentSecurityPolicy, isAllowedHost, resolvePublicFile, securityHeaders } from '../scripts/server-lib.mjs';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'platen-server-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'src', 'app.js'), 'export {};');
  writeFileSync(join(root, '.git', 'config'), 'private');
  return root;
}

test('static server resolves only explicit public application paths', () => {
  const root = fixtureRoot();
  assert.equal(resolvePublicFile(root, '/'), realpathSync(join(root, 'index.html')));
  assert.equal(resolvePublicFile(root, '/src/app.js'), realpathSync(join(root, 'src', 'app.js')));
  assert.equal(resolvePublicFile(root, '/.git/config'), null);
  assert.equal(resolvePublicFile(root, '/README.md'), null);
  assert.equal(resolvePublicFile(root, '/src/../.git/config'), null);
});

test('static server rejects symlink escapes', () => {
  const root = fixtureRoot();
  symlinkSync('/etc/hosts', join(root, 'src', 'outside.js'));
  assert.equal(resolvePublicFile(root, '/src/outside.js'), null);
});

test('static server checks Host and emits browser security headers', () => {
  assert.equal(isAllowedHost('127.0.0.1:4173', '127.0.0.1', 4173), true);
  assert.equal(isAllowedHost('localhost:4173', '127.0.0.1', 4173), true);
  assert.equal(isAllowedHost('attacker.example', '127.0.0.1', 4173), false);
  const headers = securityHeaders();
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  assert.match(contentSecurityPolicy, /(?:^|; )frame-src blob:(?:;|$)/);
  assert.doesNotMatch(contentSecurityPolicy, /frame-src (?:'self'|https?:)/);
});
