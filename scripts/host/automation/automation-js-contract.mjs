import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { AUTOMATION_INSPECT_TYPE } from './automation-operation-contract.mjs';
import { normalizeAutomationApiSubmitRequest } from './automation-api-contract.mjs';

export const AUTOMATION_JS_PROFILE = 'local-automation-declarative-recipes-v1';
export const AUTOMATION_JS_SCHEMA_VERSION = 1;
export const AUTOMATION_JS_MAX_STEPS = 8;
export const AUTOMATION_JS_MAX_REPEATS = 4;
export const AUTOMATION_JS_MAX_ADMISSIONS = 32;
export const AUTOMATION_JS_MAX_EXECUTIONS = 64;
export const AUTOMATION_JS_LIMITATIONS = Object.freeze([
  'No JavaScript source is executed; recipes are fixed host-defined declarative descriptors.',
  'No eval, VM, shell, dynamic expressions, imports, network, filesystem paths, or arbitrary loops are accepted.',
  'Recipes may only submit existing allowlisted local automation operations through the capability-gated API.',
]);

const RECIPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const EXECUTION_ID = /^ajs_[a-f0-9]{32}$/u;

export function automationJsFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', `${label} must be a plain object.`);
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { descriptors = null; }
  const actual = descriptors ? Reflect.ownKeys(value) : [];
  if (!descriptors || actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
      || descriptors[key].enumerable !== true)) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function validatedBase(principal, grant, source, idempotencyKey) {
  try {
    return normalizeAutomationApiSubmitRequest({
      principal,
      grant,
      source,
      operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null },
      idempotencyKey,
    });
  } catch (error) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', 'Declarative recipe identity, grant, source, or idempotency binding is invalid.', 400, error);
  }
}

export function normalizeAutomationJsExecuteRequest(value) {
  const item = exact(value, ['grant', 'idempotencyKey', 'principal', 'profile', 'recipe', 'source'],
    'automation declarative recipe request');
  if (item.profile !== AUTOMATION_JS_PROFILE) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', 'Declarative recipe profile is invalid.');
  }
  const recipe = exact(item.recipe, ['id', 'repeat', 'version'], 'declarative recipe selection');
  if (!RECIPE_ID.test(recipe.id ?? '') || recipe.version !== 1
    || !Number.isSafeInteger(recipe.repeat) || recipe.repeat < 1
    || recipe.repeat > AUTOMATION_JS_MAX_REPEATS) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', 'Declarative recipe selection is outside its fixed bound.');
  }
  const base = validatedBase(item.principal, item.grant, item.source, item.idempotencyKey);
  return Object.freeze({
    schemaVersion: AUTOMATION_JS_SCHEMA_VERSION,
    profile: AUTOMATION_JS_PROFILE,
    principal: base.principal,
    grant: base.grant,
    source: base.source,
    recipe: Object.freeze({ id: recipe.id, version: 1, repeat: recipe.repeat }),
    idempotencyKey: base.idempotencyKey,
  });
}

export function normalizeAutomationJsCancelRequest(value) {
  const item = exact(value, ['executionId', 'grant', 'principal', 'profile'],
    'automation declarative recipe cancel request');
  if (item.profile !== AUTOMATION_JS_PROFILE || !EXECUTION_ID.test(item.executionId ?? '')) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', 'Declarative recipe cancellation is invalid.');
  }
  const base = validatedBase(item.principal, item.grant,
    { id: 'automation_js_cancel', sha256: 'a'.repeat(64) }, 'automation-js-cancel');
  return Object.freeze({
    schemaVersion: 1,
    profile: AUTOMATION_JS_PROFILE,
    principal: base.principal,
    grant: base.grant,
    executionId: item.executionId,
  });
}

export function normalizeAutomationJsReleaseRequest(value) {
  const item = exact(value, ['executionId', 'grant', 'principal', 'profile'],
    'automation declarative recipe release request');
  if (item.profile !== AUTOMATION_JS_PROFILE || !EXECUTION_ID.test(item.executionId ?? '')) {
    automationJsFail('INVALID_AUTOMATION_JS_REQUEST', 'Declarative recipe release is invalid.');
  }
  const base = validatedBase(item.principal, item.grant,
    { id: 'automation_js_release', sha256: 'a'.repeat(64) }, 'automation-js-release');
  return Object.freeze({
    schemaVersion: 1,
    profile: AUTOMATION_JS_PROFILE,
    principal: base.principal,
    grant: base.grant,
    executionId: item.executionId,
  });
}

export function automationJsFingerprint(request) {
  return createHash('sha256').update(JSON.stringify({
    principal: request.principal,
    grant: request.grant,
    source: request.source,
    recipe: request.recipe,
  }), 'utf8').digest('hex');
}

export function automationJsExecutionId(request) {
  const digest = createHash('sha256').update(JSON.stringify({
    principal: request.principal,
    source: request.source,
    recipe: request.recipe,
    idempotencyKey: request.idempotencyKey,
  }), 'utf8').digest('hex');
  return `ajs_${digest.slice(0, 32)}`;
}
