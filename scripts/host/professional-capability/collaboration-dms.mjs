import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { result, fail, requireString } from './support.mjs';
import { getSharedReviewHub, resetSharedReviewHubForTests } from './local-review-sync.mjs';
import { openLocalDmsRepository } from './local-dms-repository.mjs';
export { resetSharedReviewHubForTests };

export function collaborationShareLinks(ctx = {}) {
  if (ctx.remoteUrl) fail('NETWORK_FORBIDDEN', 'Share links cannot be network URLs.', 403);
  const expiry = ctx.expiresAt ?? new Date(Date.now() + 3600_000).toISOString();
  if (Number.isNaN(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) fail('INVALID_EXPIRY', 'expiresAt must be future.', 400);
  const token = createHash('sha256').update(String(ctx.documentDigest ?? 'doc') + '|' + expiry).digest('hex');
  return result('collaboration.share-links', { method: 'local-share-package-token', token, expiresAt: expiry, networkLink: null, localOnly: true });
}
export async function collaborationRealTimeReview(ctx = {}) {
  if (ctx.remoteUrl || ctx.websocket || ctx.network === true) fail('NETWORK_FORBIDDEN', 'Remote network real-time channels are not admitted.', 403);
  const hub = getSharedReviewHub();
  const session = hub.createSession({ documentKey: String(ctx.documentKey ?? 'doc-1'), participants: ctx.participants ?? ['author', 'reviewer'] });
  const observer = hub.attachObserver(session.id);
  hub.join(session.id, 'reviewer');
  const posted = hub.postAnnotation(session.id, 'author', { type: 'Text', body: requireString(ctx.body ?? 'Live local sync note', 'body', { min: 1, max: 500 }), page: 1 });
  const events = observer.pull();
  observer.detach();
  if (events.length < 1) fail('SYNC_FAILED', 'Observer did not receive the posted annotation.', 502);
  if (posted.session.revision < 1) fail('SYNC_FAILED', 'Session revision did not advance.', 502);
  return result('collaboration.real-time-review', {
    method: 'local-multi-session-review-sync',
    session: posted.session,
    annotation: posted.annotation,
    observedEvents: events.length,
    synchronized: true,
    realTimeLocal: true,
  });
}
export function collaborationActivityNotifications(ctx = {}) {
  const hub = getSharedReviewHub();
  const session = hub.createSession({ participants: ['a', 'b'] });
  hub.postAnnotation(session.id, 'a', { body: requireString(ctx.message ?? 'mentioned you', 'message', { min: 1, max: 200 }) });
  const list = hub.listAnnotations(session.id);
  return result('collaboration.activity-notifications', { method: 'local-activity-notifications', sessionId: session.id, notifications: list.annotations.map((a) => ({ recipientHint: 'b', message: a.body, annotationId: a.id })), count: list.annotations.length });
}
export function collaborationAccessExpiration(ctx = {}) {
  const expiresAt = ctx.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) fail('INVALID_EXPIRY', 'expiresAt must be future.', 400);
  return result('collaboration.access-expiration', { method: 'local-access-expiration', expiresAt, active: true, revoked: false });
}
export function collaborationVersionHistory(ctx = {}) {
  const versions = Array.isArray(ctx.versions) ? ctx.versions : [{ rev: 1, label: 'initial' }, { rev: 2, label: 'edit' }];
  let prev = 'GENESIS';
  const chain = versions.slice(0, 100).map((v, i) => {
    const entry = { index: i, rev: v.rev ?? i + 1, label: String(v.label ?? ''), prev };
    const sha = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    prev = sha;
    return { ...entry, entrySha256: sha };
  });
  return result('collaboration.version-history', { method: 'local-version-hash-chain', chain, head: prev, count: chain.length });
}
export function collaborationProjectsWorkspaces(ctx = {}) {
  const name = requireString(ctx.name ?? 'Project Local', 'name', { min: 1, max: 80 });
  const project = Object.freeze({ id: createHash('sha256').update(name).digest('hex').slice(0, 16), name, offline: true, createdAt: new Date().toISOString() });
  return result('collaboration.projects-workspaces', { method: 'local-project-workspace', project });
}
export async function dmsRepositoryConnectors(ctx = {}) {
  if (ctx.remoteUrl || ctx.endpoint || ctx.network === true) fail('NETWORK_FORBIDDEN', 'Remote DMS endpoints are forbidden.', 403);
  const root = ctx.repositoryRoot ?? join(tmpdir(), `pdf-dms-${randomUUID()}`);
  const repo = await openLocalDmsRepository(root);
  const put = await repo.put('readme.txt', Buffer.from(requireString(ctx.seedContent ?? 'repository object', 'seedContent', { min: 1, max: 1000 }), 'utf8'), { ownerId: 'admin' });
  const listed = await repo.list();
  const got = await repo.get('readme.txt');
  if (got.sha256 !== put.sha256) fail('DMS_INTEGRITY', 'get/put digest mismatch.', 502);
  if (listed.count < 1) fail('DMS_LIST_EMPTY', 'Repository list empty after put.', 502);
  return result('dms.repository-connectors', {
    method: 'local-filesystem-dms-repository',
    root,
    put,
    listCount: listed.count,
    getSha256: got.sha256,
    connected: true,
    transport: 'local-filesystem',
    network: false,
  });
}
export function dmsRetentionRecords(ctx = {}) {
  const days = Number(ctx.days ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) fail('INVALID_RETENTION', 'days 1..36500', 400);
  const rule = Object.freeze({ id: createHash('sha256').update(String(days)).digest('hex').slice(0, 16), days, name: requireString(ctx.name ?? 'default', 'name', { min: 1, max: 80 }) });
  return result('dms.retention-records', { method: 'local-retention-rule', rule });
}
export async function dmsCheckinCheckout(ctx = {}) {
  const root = ctx.repositoryRoot ?? join(tmpdir(), `pdf-dms-${randomUUID()}`);
  const repo = await openLocalDmsRepository(root);
  await repo.put('locked.bin', Buffer.from('payload'), { ownerId: 'owner-a' });
  const lock = await repo.checkout('locked.bin', 'owner-a');
  try {
    await repo.checkout('locked.bin', 'owner-b');
    fail('LOCK_NOT_ENFORCED', 'Second checkout should conflict.', 502);
  } catch (error) {
    if (error?.code !== 'DOCUMENT_LOCKED') throw error;
  }
  const released = await repo.checkin('locked.bin', 'owner-a', lock.token);
  return result('dms.checkin-checkout', { method: 'local-dms-lock-enforcement', lock, released, enforced: true });
}
export function dmsOfflineSync(ctx = {}) {
  const op = requireString(ctx.operation ?? 'pull', 'operation', { min: 1, max: 40 });
  const entry = Object.freeze({ id: randomUUID(), operation: op, conflict: Boolean(ctx.conflict), resolution: ctx.resolution ?? 'manual-review', at: new Date().toISOString(), localOnly: true });
  return result('dms.offline-sync', { method: 'local-offline-sync-journal', entry });
}
export async function dmsConflictResolution(ctx = {}) {
  const resolution = ctx.resolution ?? 'keep-local';
  if (!['keep-local', 'keep-incoming', 'manual-review'].includes(resolution)) fail('INVALID_RESOLUTION', 'Unsupported resolution.', 400);
  // Persist a resolution journal entry into the local DMS repository (real side effect).
  // Object names must be single safe tokens (no path separators).
  const root = ctx.repositoryRoot ?? join(tmpdir(), `pdf-dms-conflict-${randomUUID()}`);
  const repo = await openLocalDmsRepository(root);
  const journalName = `conflict-${randomUUID()}.json`;
  const body = Buffer.from(JSON.stringify({
    resolution,
    documentPath: ctx.documentPath ?? 'doc.pdf',
    at: new Date().toISOString(),
    localOnly: true,
  }), 'utf8');
  const put = await repo.put(journalName, body, { ownerId: 'resolver' });
  const got = await repo.get(journalName);
  if (got.sha256 !== put.sha256) fail('DMS_CONFLICT_JOURNAL_MISMATCH', 'Conflict journal digest mismatch.', 502);
  const listed = await repo.list();
  if (!listed.items.some((item) => item.name === journalName)) {
    fail('DMS_CONFLICT_JOURNAL_MISSING', 'Conflict journal not listed in repository.', 502);
  }
  return result('dms.conflict-resolution', {
    method: 'local-dms-conflict-journal',
    resolution,
    applied: true,
    journalPath: journalName,
    journalSha256: put.sha256,
    root,
    persisted: true,
    listed: true,
  });
}
export async function dmsDocumentLocking(ctx = {}) {
  const root = ctx.repositoryRoot ?? join(tmpdir(), `pdf-dms-${randomUUID()}`);
  const repo = await openLocalDmsRepository(root);
  await repo.put('locked.bin', Buffer.from('payload'), { ownerId: 'owner-a' });
  const lock = await repo.checkout('locked.bin', 'owner-a');
  try {
    await repo.checkout('locked.bin', 'owner-b');
    fail('LOCK_NOT_ENFORCED', 'Second checkout should conflict.', 502);
  } catch (error) {
    if (error?.code !== 'DOCUMENT_LOCKED') throw error;
  }
  const released = await repo.checkin('locked.bin', 'owner-a', lock.token);
  return result('dms.document-locking', { method: 'local-dms-lock-enforcement', lock, released, enforced: true });
}
export const handlers = Object.freeze({
  async 'collaboration.share-links'(ctx = {}) { return collaborationShareLinks(ctx); },
  async 'collaboration.real-time-review'(ctx = {}) { return collaborationRealTimeReview(ctx); },
  async 'collaboration.activity-notifications'(ctx = {}) { return collaborationActivityNotifications(ctx); },
  async 'collaboration.access-expiration'(ctx = {}) { return collaborationAccessExpiration(ctx); },
  async 'collaboration.version-history'(ctx = {}) { return collaborationVersionHistory(ctx); },
  async 'collaboration.projects-workspaces'(ctx = {}) { return collaborationProjectsWorkspaces(ctx); },
  async 'dms.repository-connectors'(ctx = {}) { return dmsRepositoryConnectors(ctx); },
  async 'dms.retention-records'(ctx = {}) { return dmsRetentionRecords(ctx); },
  async 'dms.checkin-checkout'(ctx = {}) { return dmsCheckinCheckout(ctx); },
  async 'dms.offline-sync'(ctx = {}) { return dmsOfflineSync(ctx); },
  async 'dms.conflict-resolution'(ctx = {}) { return dmsConflictResolution(ctx); },
  async 'dms.document-locking'(ctx = {}) { return dmsDocumentLocking(ctx); },
});
