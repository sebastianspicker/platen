/**
 * Admin professional-capability handlers (identity, policy, packaging).
 */
import { createHash } from 'node:crypto';
import { result, fail, requireString } from './support.mjs';

function sha(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function denyNetwork(ctx = {}) {
  if (ctx.remoteUrl || ctx.network === true || ctx.apiEndpoint || ctx.webhookUrl) {
    fail('NETWORK_FORBIDDEN', 'Admin cannot open network endpoints in local-only mode.', 403);
  }
}

export function adminIdentityRoles(ctx = {}) {
  const roles = Array.isArray(ctx.roles) ? ctx.roles.map(String).slice(0, 50) : ['admin', 'reviewer', 'viewer'];
  const userId = requireString(ctx.userId ?? 'local-user', 'userId', { min: 1, max: 80 });
  const principal = Object.freeze({
    userId,
    roles: Object.freeze([...roles]),
  });
  return result('admin.identity-roles', {
    method: 'local-admin-identity-roles',
    userId,
    roles: Object.freeze([...roles]),
    principal,
  });
}

export function adminSsoScim(ctx = {}) {
  denyNetwork(ctx);
  if (ctx.sso === true || ctx.scim === true) {
    fail('NETWORK_FORBIDDEN', 'SSO/SCIM requires remote directory adapters.', 403);
  }
  const sso = Object.freeze({ enabled: false, providers: Object.freeze([]) });
  const scim = Object.freeze({ enabled: false, provisioning: false });
  const config = Object.freeze({
    sso,
    scim,
    localIdentityOnly: true,
  });
  return result('admin.sso-scim', {
    method: 'local-sso-scim-disabled-configuration',
    sso,
    scim,
    config,
  });
}

export function adminDeploymentPackaging(ctx = {}) {
  const packageId = requireString(ctx.packageId ?? 'platen-local', 'packageId', { min: 1, max: 80 });
  const version = requireString(ctx.version ?? '0.3.0-alpha.1', 'version', { min: 1, max: 40 });
  const includes = Object.freeze(['app', 'host', 'catalog']);
  const manifest = Object.freeze({
    packageId,
    version,
    format: 'directory-tree',
    includes,
  });
  return result('admin.deployment-packaging', {
    method: 'local-admin-deployment-manifest',
    packageId,
    version,
    format: 'directory-tree',
    manifest,
  });
}

export function adminUpdateManagement(ctx = {}) {
  const channel = requireString(ctx.channel ?? 'alpha', 'channel', { min: 1, max: 40 });
  return result('admin.update-management', {
    method: 'local-admin-update-channel',
    channel,
    autoUpdate: false,
    currentVersion: '0.3.0-alpha.1',
  });
}

export function adminLicensing(ctx = {}) {
  const entitlement = Object.freeze({
    commercial: false,
    sourceAvailable: true,
  });
  return result('admin.licensing', {
    method: 'local-admin-license-mit',
    license: 'MIT',
    seats: null,
    offline: true,
    entitlement,
  });
}

export function adminPolicyConfiguration(ctx = {}) {
  const policy = Object.freeze({
    network: false,
    pluginExecution: false,
    maxUploadBytes: 64 * 1024 * 1024,
    ...((ctx.policy && typeof ctx.policy === 'object') ? ctx.policy : {}),
    network: false,
    pluginExecution: false,
  });
  return result('admin.policy-configuration', {
    method: 'local-admin-policy-config',
    policy,
    policySha256: sha(policy),
  });
}

export function adminDataResidency(ctx = {}) {
  return result('admin.data-residency', {
    method: 'local-admin-data-residency',
    residency: 'local-device-only',
    regions: Object.freeze([]),
    crossBorder: false,
  });
}

export function adminUsageReporting(ctx = {}) {
  const opens = Number(ctx.opens ?? 0);
  const exportsCount = Number(ctx.exports ?? 0);
  const redactions = Number(ctx.redactions ?? 0);
  const counters = Object.freeze({
    opens,
    exports: exportsCount,
    redactions,
    total: opens + exportsCount + redactions,
  });
  return result('admin.usage-reporting', {
    method: 'local-admin-usage-counters',
    counters,
  });
}

export function adminPluginAllowlist(ctx = {}) {
  const allow = Array.isArray(ctx.allow) ? ctx.allow.map(String).slice(0, 100) : [];
  const policy = Object.freeze({
    defaultDeny: true,
    allowCount: allow.length,
  });
  return result('admin.plugin-allowlist', {
    method: 'local-admin-plugin-allowlist',
    allow: Object.freeze(allow),
    count: allow.length,
    defaultDeny: true,
    policy,
  });
}
