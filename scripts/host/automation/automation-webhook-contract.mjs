import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { AUTOMATION_INSPECT_TYPE, OPAQUE_ID } from './automation-operation-contract.mjs';
import { normalizeAutomationApiSubmitRequest } from './automation-api-contract.mjs';

export const AUTOMATION_WEBHOOK_SCHEMA_VERSION = 1;
export const AUTOMATION_WEBHOOK_MAX_EVENTS = 64;
export const AUTOMATION_WEBHOOK_MAX_ATTEMPTS = 3;
export const AUTOMATION_WEBHOOK_EVENT_TYPES = Object.freeze([
  'source.stored', 'job.completed', 'output.created',
]);
const DESTINATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const EVENT_TYPES = new Set(AUTOMATION_WEBHOOK_EVENT_TYPES);

export function webhookFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) webhookFail('INVALID_AUTOMATION_WEBHOOK', `${label} must be a plain object.`);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { descriptors = null; }
  const actual = descriptors ? Reflect.ownKeys(value) : [];
  if (!descriptors || actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) webhookFail('INVALID_AUTOMATION_WEBHOOK', `${label} contains unsupported fields, accessors, or symbols.`);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function eventReference(raw) {
  const event = exact(raw, ['jobId', 'outputId', 'sourceId', 'type'], 'webhook event reference');
  if (!EVENT_TYPES.has(event.type)) webhookFail('INVALID_AUTOMATION_WEBHOOK', 'Webhook event type is not allowlisted.');
  if (!OPAQUE_ID.test(event.sourceId ?? '')
    || (event.jobId !== null && !OPAQUE_ID.test(event.jobId ?? ''))
    || (event.outputId !== null && !OPAQUE_ID.test(event.outputId ?? ''))
    || (event.type === 'source.stored' && (event.jobId !== null || event.outputId !== null))
    || (event.type === 'job.completed' && (event.jobId === null || event.outputId !== null))
    || (event.type === 'output.created' && (event.jobId === null || event.outputId === null))) webhookFail('INVALID_AUTOMATION_WEBHOOK', 'Webhook event identifiers do not match the fixed event type.');
  return Object.freeze({ type: event.type, sourceId: event.sourceId, jobId: event.jobId, outputId: event.outputId });
}

export function normalizeAutomationWebhookDeliverRequest(value) {
  const item = exact(value, ['destinationId', 'event', 'grant', 'idempotencyKey', 'principal'], 'webhook delivery request');
  if (typeof item.destinationId !== 'string' || !DESTINATION_ID.test(item.destinationId)) webhookFail('INVALID_AUTOMATION_WEBHOOK', 'Webhook destination ID is invalid.');
  const event = eventReference(item.event);
  const base = normalizeAutomationApiSubmitRequest({ principal: item.principal, grant: item.grant,
    source: { id: event.sourceId, sha256: 'a'.repeat(64) },
    operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, idempotencyKey: item.idempotencyKey });
  return Object.freeze({ schemaVersion: AUTOMATION_WEBHOOK_SCHEMA_VERSION, principal: base.principal, grant: base.grant,
    destinationId: item.destinationId, idempotencyKey: base.idempotencyKey, event });
}

function eventAction(value, label) {
  const item = exact(value, ['eventId', 'grant', 'principal'], label);
  const base = normalizeAutomationApiSubmitRequest({ principal: item.principal, grant: item.grant,
    source: { id: 'webhook_action', sha256: 'a'.repeat(64) }, operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, idempotencyKey: 'webhook-action' });
  if (typeof item.eventId !== 'string' || !/^wh_[a-f0-9]{32}$/u.test(item.eventId)) webhookFail('INVALID_AUTOMATION_WEBHOOK', 'Webhook event ID is invalid.');
  return Object.freeze({ schemaVersion: 1, principal: base.principal, grant: base.grant, eventId: item.eventId });
}

export const normalizeAutomationWebhookRetryRequest = (value) => eventAction(value, 'webhook retry request');
export const normalizeAutomationWebhookCancelRequest = (value) => eventAction(value, 'webhook cancel request');
