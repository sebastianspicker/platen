import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { AUTOMATION_WEBHOOK_EVENT_TYPES, webhookFail } from './automation-webhook-contract.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) webhookFail('AUTOMATION_WEBHOOK_DESTINATION_INVALID', `${label} is invalid.`, 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) webhookFail('AUTOMATION_WEBHOOK_DESTINATION_INVALID', `${label} contains unsupported fields or accessors.`, 502);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function eventTypes(value) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length < 1 || value.length > AUTOMATION_WEBHOOK_EVENT_TYPES.length) webhookFail('AUTOMATION_WEBHOOK_DESTINATION_INVALID', 'Trusted destination event types are invalid.', 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)
    || Number(key) >= value.length || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) webhookFail('AUTOMATION_WEBHOOK_DESTINATION_INVALID', 'Trusted destination event types must be data-only.', 502);
  const items = Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
  if (new Set(items).size !== items.length || items.some((item) => !AUTOMATION_WEBHOOK_EVENT_TYPES.includes(item))) webhookFail('AUTOMATION_WEBHOOK_DESTINATION_INVALID', 'Trusted destination event types are invalid.', 502);
  return Object.freeze(items);
}

export function normalizeTrustedWebhookDestination(value, expectedId, eventType) {
  const item = exact(value, ['eventTypes', 'id', 'identityDigest', 'status'], 'trusted webhook destination');
  if (item.id !== expectedId || !ID.test(item.id ?? '') || !SHA256.test(item.identityDigest ?? '')
    || !['ready', 'disabled'].includes(item.status)) webhookFail('AUTOMATION_WEBHOOK_DESTINATION_INVALID', 'Trusted webhook destination identity is invalid.', 502);
  const allowed = eventTypes(item.eventTypes);
  if (item.status !== 'ready') webhookFail('AUTOMATION_WEBHOOK_DESTINATION_UNAVAILABLE', 'Trusted webhook destination is unavailable.', 503);
  if (!allowed.includes(eventType)) webhookFail('AUTOMATION_WEBHOOK_EVENT_DENIED', 'Trusted webhook destination does not accept this event type.', 403);
  return Object.freeze({ id: item.id, identityDigest: item.identityDigest });
}

function factsExact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', `${label} is invalid.`, 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', `${label} contains unsupported fields or accessors.`, 502);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function boundedSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024) webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', `${label} size is outside the fixed bound.`, 502);
  return value;
}

export function normalizeTrustedWebhookEventFacts(value, reference) {
  const event = factsExact(value, ['job', 'output', 'source', 'type'], 'trusted webhook event facts');
  const source = factsExact(event.source, ['id', 'sha256', 'size'], 'trusted webhook source facts');
  if (event.type !== reference.type || source.id !== reference.sourceId || !ID.test(source.id ?? '')
    || !SHA256.test(source.sha256 ?? '')) webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', 'Trusted webhook source binding is invalid.', 502);
  const checkedSource = Object.freeze({ id: source.id, sha256: source.sha256, size: boundedSize(source.size, 'Trusted webhook source') });
  let job = null;
  if (event.job !== null) {
    const item = factsExact(event.job, ['id', 'operation', 'status'], 'trusted webhook job facts');
    if (item.id !== reference.jobId || !ID.test(item.id ?? '') || typeof item.operation !== 'string'
      || !/^[a-z][a-z0-9.-]{0,127}$/u.test(item.operation) || item.status !== 'completed') webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', 'Trusted webhook job binding is invalid.', 502);
    job = Object.freeze({ id: item.id, operation: item.operation, status: item.status });
  }
  let output = null;
  if (event.output !== null) {
    const item = factsExact(event.output, ['id', 'mediaType', 'sha256', 'size'], 'trusted webhook output facts');
    if (item.id !== reference.outputId || !ID.test(item.id ?? '') || !SHA256.test(item.sha256 ?? '')
      || item.mediaType !== 'application/pdf') webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', 'Trusted webhook output binding is invalid.', 502);
    output = Object.freeze({ id: item.id, mediaType: item.mediaType, sha256: item.sha256, size: boundedSize(item.size, 'Trusted webhook output') });
  }
  if ((reference.type === 'source.stored' && (job !== null || output !== null))
    || (reference.type === 'job.completed' && (job === null || output !== null))
    || (reference.type === 'output.created' && (job === null || output === null))) webhookFail('AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID', 'Trusted webhook facts do not match the fixed event type.', 502);
  return Object.freeze({ type: event.type, source: checkedSource, job, output });
}

export function createAutomationWebhookEnvelope(eventId, destination, event) {
  const payload = Object.freeze({ schemaVersion: 1, eventId, type: event.type, source: event.source, job: event.job, output: event.output });
  const canonicalPayload = JSON.stringify(payload);
  if (Buffer.byteLength(canonicalPayload, 'utf8') > 4096) webhookFail('AUTOMATION_WEBHOOK_PAYLOAD_LIMIT', 'Webhook payload exceeds the fixed bound.', 413);
  const payloadDigest = createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
  const binding = Object.freeze({ schemaVersion: 1, destination: Object.freeze({ ...destination }), payloadDigest });
  const envelopeDigest = createHash('sha256').update(JSON.stringify(binding), 'utf8').digest('hex');
  return Object.freeze({ schemaVersion: 1, destination: binding.destination, payload, payloadDigest, envelopeDigest,
    signatureInput: `sha256=${envelopeDigest}` });
}

export class UnavailableWebhookDestinationInventory {
  async resolve() { throw new HostError('AUTOMATION_WEBHOOK_DESTINATION_UNAVAILABLE', 'No trusted webhook destination inventory is configured.', 503); }
}

export class UnavailableWebhookEventFactsResolver {
  async resolve() { throw new HostError('AUTOMATION_WEBHOOK_EVENT_FACTS_UNAVAILABLE', 'No trusted webhook event facts resolver is configured.', 503); }
}

export class UnavailableWebhookDeliveryAdapter {
  async deliver() { throw new HostError('AUTOMATION_WEBHOOK_UNAVAILABLE', 'No trusted webhook delivery adapter is configured.', 503); }
  async cancel() {}
}
