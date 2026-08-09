import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalAdminAuditAuthority } from '../scripts/host/admin-audit-authority.mjs';

const moduleUrl = new URL('../scripts/host/admin-audit-authority.mjs', import.meta.url).href;
async function root() { return mkdtemp(join(tmpdir(), 'platen-admin-audit-')); }
async function audit(options = {}) { return new LocalAdminAuditAuthority({ root: join(await root(), 'audit'), now: () => new Date('2026-08-04T00:00:00.000Z'), ...options }).initialize(); }
function event(eventId, more = {}) { return { eventId, action: 'package.install', subject: 'plugin.example', outcome: 'succeeded', ...more }; }
function appendChild(location, eventId) {
  const program = `import { LocalAdminAuditAuthority } from ${JSON.stringify(moduleUrl)}; const audit = await new LocalAdminAuditAuthority({root:process.env.AUDIT_ROOT}).initialize(); console.log(JSON.stringify(await audit.append({eventId:process.env.EVENT_ID,action:'package.install',subject:'plugin.example',outcome:'succeeded'})));`;
  return new Promise((resolveChild, rejectChild) => { const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { env: { ...process.env, AUDIT_ROOT: location, EVENT_ID: eventId } }); let output = ''; let errors = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; }); child.once('error', rejectChild); child.once('close', (code) => code ? rejectChild(new Error(errors)) : resolveChild(JSON.parse(output))); });
}

test('initializes canonical private immutable state and lists an empty chain', async () => {
  const base = await root(); const location = join(base, 'audit'); const authority = await new LocalAdminAuditAuthority({ root: location }).initialize();
  const listed = await authority.list(); assert.deepEqual(listed, { schemaVersion: 1, count: 0, head: 'GENESIS', stateSha256: listed.stateSha256, records: [] });
  assert.throws(() => { listed.records.push({}); }, TypeError); assert.equal((await lstat(location)).mode & 0o777, 0o700); assert.equal((await lstat(join(location, 'admin-audit.json'))).mode & 0o777, 0o600);
  const text = await readFile(join(location, 'admin-audit.json'), 'utf8'); const parsed = JSON.parse(text); assert.equal(text.startsWith('{"records":[],"schemaVersion":1,"stateSha256":"'), true); assert.equal(parsed.stateSha256, listed.stateSha256);
});

test('appends a digest-bound immutable chain, restarts, limits, and deduplicates exact events', async () => {
  const base = await root(); const location = join(base, 'audit'); let tick = 0; const now = () => new Date(`2026-08-04T00:00:0${tick += 1}.000Z`);
  const first = await new LocalAdminAuditAuthority({ root: location, now }).initialize(); const one = await first.append(event('one')); const two = await first.append(event('two', { action: 'package.activate' }));
  assert.equal(one.record.previousSha256, 'GENESIS'); assert.equal(two.record.previousSha256, one.record.eventSha256); assert.throws(() => { one.record.subject = 'changed'; }, TypeError);
  assert.equal((await first.append(event('one'))).appended, false); await assert.rejects(first.append(event('one', { subject: 'other' })), { code: 'ADMIN_AUDIT_EVENT_CONFLICT', status: 409 });
  const restored = await new LocalAdminAuditAuthority({ root: location }).initialize(); const listed = await restored.list({ limit: 1 }); assert.equal(listed.count, 2); assert.deepEqual(listed.records, [two.record]); assert.equal(listed.head, two.record.eventSha256);
});

test('rejects malformed callers before traps and input or list bounds', async () => {
  const authority = await audit(); const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
  await assert.rejects(authority.append(hostile), { code: 'ADMIN_AUDIT_INVALID' });
  for (const value of [event('bad id'), event('x', { action: 'delete' }), event('x', { subject: 'bad\nsubject' }), event('x', { outcome: 'failed' })]) await assert.rejects(authority.append(value), { code: 'ADMIN_AUDIT_INVALID' });
  for (const limit of [0, 101, 1.5, '1']) await assert.rejects(authority.list({ limit }), { code: 'ADMIN_AUDIT_LIMIT_INVALID' });
});

test('fails closed on full storage and on corrupt, noncanonical, digest, or chain state', async () => {
  const base = await root(); const location = join(base, 'audit'); const authority = await new LocalAdminAuditAuthority({ root: location, maxRecords: 1 }).initialize(); await authority.append(event('one')); await assert.rejects(authority.append(event('two')), { code: 'ADMIN_AUDIT_FULL' });
  const path = join(location, 'admin-audit.json'); const original = await readFile(path, 'utf8');
  for (const text of ['{}', `${original} `, original.replace(/stateSha256":"[a-f0-9]+/u, 'stateSha256":"000'), original.replace('package.install', 'package.activate')]) { await writeFile(path, text, { mode: 0o600 }); await assert.rejects(new LocalAdminAuditAuthority({ root: location }).initialize(), (error) => ['ADMIN_AUDIT_STATE_INVALID', 'ADMIN_AUDIT_STATE_INTEGRITY_FAILED', 'ADMIN_AUDIT_CHAIN_INVALID'].includes(error.code)); }
});

test('rejects unsafe root, state links, stale locks, and path-bearing initialization errors', async () => {
  const base = await root(); const location = join(base, 'audit'); const authority = await new LocalAdminAuditAuthority({ root: location }).initialize(); const path = join(location, 'admin-audit.json');
  await chmod(path, 0o644); await assert.rejects(new LocalAdminAuditAuthority({ root: location }).initialize(), { code: 'ADMIN_AUDIT_STATE_UNSAFE' }); await chmod(path, 0o600);
  await link(path, join(location, 'linked')); await assert.rejects(new LocalAdminAuditAuthority({ root: location }).initialize(), { code: 'ADMIN_AUDIT_STATE_UNSAFE' }); await unlink(join(location, 'linked'));
  const external = join(base, 'external'); await writeFile(external, await readFile(path)); await unlink(path); await symlink(external, path); await assert.rejects(new LocalAdminAuditAuthority({ root: location }).initialize(), { code: 'ADMIN_AUDIT_STATE_UNSAFE' }); await unlink(path);
  await writeFile(join(location, '.admin-audit.lock'), '', { mode: 0o600 }); await assert.rejects(authority.list(), { code: 'ADMIN_AUDIT_BUSY' }); await unlink(join(location, '.admin-audit.lock'));
  const obstacle = join(base, 'file'); await writeFile(obstacle, 'x'); await assert.rejects(new LocalAdminAuditAuthority({ root: join(obstacle, 'audit') }).initialize(), (error) => !error.message.includes(base));
});

test('serializes cross-process duplicate and distinct append operations', async () => {
  const base = await root(); const location = join(base, 'audit'); await new LocalAdminAuditAuthority({ root: location }).initialize();
  const same = await Promise.all([appendChild(location, 'same'), appendChild(location, 'same')]); assert.equal(same.filter((item) => item.appended).length, 1); assert.equal(same.filter((item) => !item.appended).length, 1);
  await Promise.all([appendChild(location, 'a'), appendChild(location, 'b')]); const records = (await new LocalAdminAuditAuthority({ root: location }).initialize()).list(); const state = await records;
  assert.deepEqual(state.records.map((item) => item.sequence), [1, 2, 3]); assert.deepEqual(new Set(state.records.map((item) => item.eventId)), new Set(['same', 'a', 'b']));
});

test('fails closed when a rename race replaces state before append', async () => {
  const base = await root(); const location = join(base, 'audit'); const authority = await new LocalAdminAuditAuthority({ root: location }).initialize(); const path = join(location, 'admin-audit.json'); const replacement = join(location, 'replacement.json');
  await writeFile(replacement, '{}', { mode: 0o600 }); await rename(replacement, path); await assert.rejects(authority.append(event('race')), { code: 'ADMIN_AUDIT_STATE_INVALID' });
});

test('rejects a substituted temporary symlink without touching state or external data', async () => {
  const base = await root(); const location = join(base, 'audit'); const statePath = join(location, 'admin-audit.json'); const external = join(base, 'external.json');
  const initial = await new LocalAdminAuditAuthority({ root: location }).initialize(); const target = await readFile(statePath, 'utf8'); const externalText = 'external data must survive'; await writeFile(external, externalText, { mode: 0o600 });
  const authority = new LocalAdminAuditAuthority({ root: location, beforeRename: async (temporary) => { await unlink(temporary); await symlink(external, temporary); } });
  await authority.initialize(); await assert.rejects(authority.append(event('temp-race')), { code: 'ADMIN_AUDIT_TEMP_UNSAFE' });
  assert.equal(await readFile(statePath, 'utf8'), target); assert.equal(await readFile(external, 'utf8'), externalText); assert.equal((await initial.list()).count, 0);
});

test('does not report success if a temp path is swapped after its final pre-rename check', async () => {
  const base = await root(); const location = join(base, 'audit'); const statePath = join(location, 'admin-audit.json'); const external = join(base, 'external.json');
  await new LocalAdminAuditAuthority({ root: location }).initialize(); const externalText = 'external survives source substitution'; await writeFile(external, externalText, { mode: 0o600 });
  const authority = await new LocalAdminAuditAuthority({ root: location, afterTemporaryVerified: async (temporary) => { await unlink(temporary); await symlink(external, temporary); } }).initialize();
  await assert.rejects(authority.append(event('after-check')), (error) => error.code === 'ADMIN_AUDIT_PERSIST_UNCERTAIN' && error.committed === true);
  assert.equal((await lstat(statePath)).isSymbolicLink(), true); assert.equal(await readFile(external, 'utf8'), externalText);
});

test('does not report success if the final pathname is replaced after rename', async () => {
  const base = await root(); const location = join(base, 'audit'); const statePath = join(location, 'admin-audit.json'); const external = join(base, 'external.json');
  await new LocalAdminAuditAuthority({ root: location }).initialize(); const externalText = 'external survives final replacement'; await writeFile(external, externalText, { mode: 0o600 });
  const authority = await new LocalAdminAuditAuthority({ root: location, afterRename: async (path) => { await unlink(path); await symlink(external, path); } }).initialize();
  await assert.rejects(authority.append(event('post-rename')), (error) => error.code === 'ADMIN_AUDIT_PERSIST_UNCERTAIN' && error.committed === true);
  assert.equal((await lstat(statePath)).isSymbolicLink(), true); assert.equal(await readFile(external, 'utf8'), externalText);
});

test('a same-UID mutation after verified return is detected on the next authority use', async () => {
  const base = await root(); const location = join(base, 'audit'); const statePath = join(location, 'admin-audit.json'); const external = join(base, 'external.json');
  const authority = await new LocalAdminAuditAuthority({ root: location }).initialize(); assert.equal((await authority.append(event('returned'))).appended, true);
  const externalText = 'post-return external data'; await writeFile(external, externalText, { mode: 0o600 }); await unlink(statePath); await symlink(external, statePath);
  await assert.rejects(new LocalAdminAuditAuthority({ root: location }).initialize(), { code: 'ADMIN_AUDIT_STATE_UNSAFE' }); assert.equal(await readFile(external, 'utf8'), externalText);
});
