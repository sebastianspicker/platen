import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { AUTOMATION_INSPECT_TYPE } from './automation-operation-contract.mjs';
import { normalizeAutomationApiSubmitRequest } from './automation-api-contract.mjs';

export const AUTOMATION_PREFLIGHT_SERVER_SCHEMA_VERSION = 1;
export const AUTOMATION_PREFLIGHT_SERVER_PROFILES = Object.freeze(['print-review', 'archive-review']);
export const AUTOMATION_PREFLIGHT_SERVER_MAX_JOBS = 64;
export const AUTOMATION_PREFLIGHT_SERVER_MAX_SOURCE_BYTES = 512 * 1024 * 1024;

export function preflightServerFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) preflightServerFail('INVALID_AUTOMATION_PREFLIGHT_SERVER', `${label} must be a plain object.`);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { descriptors = null; }
  const actual = descriptors ? Reflect.ownKeys(value) : [];
  if (!descriptors || actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) preflightServerFail('INVALID_AUTOMATION_PREFLIGHT_SERVER', `${label} contains unsupported fields, accessors, or symbols.`);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

export function normalizeAutomationPreflightServerRequest(value) {
  const item = exact(value, ['grant', 'idempotencyKey', 'principal', 'profile', 'source'], 'preflight server request');
  if (!AUTOMATION_PREFLIGHT_SERVER_PROFILES.includes(item.profile)) preflightServerFail('INVALID_AUTOMATION_PREFLIGHT_SERVER', 'Preflight server profile is not allowlisted.');
  const base = normalizeAutomationApiSubmitRequest({ principal: item.principal, grant: item.grant,
    source: item.source, operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null },
    idempotencyKey: item.idempotencyKey });
  return Object.freeze({ schemaVersion: 1, principal: base.principal, grant: base.grant,
    source: base.source, profile: item.profile, idempotencyKey: base.idempotencyKey });
}

export function normalizeAutomationPreflightServerCancelRequest(value) {
  const item = exact(value, ['grant', 'jobId', 'principal'], 'preflight server cancel request');
  const base = normalizeAutomationApiSubmitRequest({ principal: item.principal, grant: item.grant,
    source: { id: 'preflight_cancel', sha256: 'a'.repeat(64) },
    operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, idempotencyKey: 'preflight-cancel' });
  if (typeof item.jobId !== 'string' || !/^pf_[a-f0-9]{32}$/u.test(item.jobId)) preflightServerFail('INVALID_AUTOMATION_PREFLIGHT_SERVER', 'Preflight server job ID is invalid.');
  return Object.freeze({ schemaVersion: 1, principal: base.principal, grant: base.grant, jobId: item.jobId });
}
