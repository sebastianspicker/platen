import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_WEBHOOK_MAX_ATTEMPTS, AUTOMATION_WEBHOOK_MAX_EVENTS,
  normalizeAutomationWebhookCancelRequest, normalizeAutomationWebhookDeliverRequest,
  normalizeAutomationWebhookRetryRequest, webhookFail,
} from './automation-webhook-contract.mjs';
import {
  createAutomationWebhookEnvelope, normalizeTrustedWebhookDestination,
  normalizeTrustedWebhookEventFacts, UnavailableWebhookDeliveryAdapter,
  UnavailableWebhookDestinationInventory, UnavailableWebhookEventFactsResolver,
} from './automation-webhook-outbox.mjs';

function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify({ grant: request.grant, destinationId: request.destinationId, event: request.event }), 'utf8').digest('hex');
}

function eventId(request, requestFingerprint) {
  return `wh_${createHash('sha256').update(JSON.stringify({ principal: request.principal,
    idempotencyKey: request.idempotencyKey, fingerprint: requestFingerprint }), 'utf8').digest('hex').slice(0, 32)}`;
}

export function automationWebhookEventId(value) {
  const request = normalizeAutomationWebhookDeliverRequest(value);
  return eventId(request, fingerprint(request));
}

function snapshotAdapterReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) webhookFail('AUTOMATION_WEBHOOK_ADAPTER_INVALID', 'Webhook adapter receipt is invalid.', 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => typeof key !== 'string' || !['deliveryId', 'envelopeDigest', 'status'].includes(key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) webhookFail('AUTOMATION_WEBHOOK_ADAPTER_INVALID', 'Webhook adapter receipt identity is invalid.', 502);
  return Object.freeze({ deliveryId: descriptors.deliveryId.value, envelopeDigest: descriptors.envelopeDigest.value, status: descriptors.status.value });
}

function snapshotAdapterDeliveryId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) webhookFail('AUTOMATION_WEBHOOK_ADAPTER_INVALID', 'Webhook adapter receipt is invalid.', 502);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'deliveryId');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    || typeof descriptor.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(descriptor.value)) webhookFail('AUTOMATION_WEBHOOK_ADAPTER_INVALID', 'Webhook adapter receipt identity is invalid.', 502);
  return descriptor.value;
}

function checkedReceipt(receipt, expectedDigest) {
  if (receipt.envelopeDigest !== expectedDigest || !['accepted', 'delivered'].includes(receipt.status)) webhookFail('AUTOMATION_WEBHOOK_ADAPTER_INVALID', 'Webhook adapter receipt binding is invalid.', 502);
  return receipt.status;
}

function denied(error) {
  if (error instanceof HostError && error.code === 'AUTOMATION_WEBHOOK_CAPABILITY_DENIED') throw error;
  throw new HostError('AUTOMATION_WEBHOOK_CAPABILITY_DENIED', 'Webhook capability was denied.', 403, { cause: error });
}

export class AutomationWebhookService {
  #authority; #inventory; #facts; #adapter; #records = new Map(); #serialized = Promise.resolve(); #closed = false; #closeOperation = null;

  constructor({ authority, destinationInventory = new UnavailableWebhookDestinationInventory(),
    eventFactsResolver = new UnavailableWebhookEventFactsResolver(), adapter = new UnavailableWebhookDeliveryAdapter() } = {}) {
    if (typeof authority?.authorize !== 'function' || typeof destinationInventory?.resolve !== 'function'
      || typeof eventFactsResolver?.resolve !== 'function' || typeof adapter?.deliver !== 'function'
      || typeof adapter?.cancel !== 'function') throw new TypeError('Webhooks require authority, trusted event facts, trusted destination inventory, and trusted delivery adapter.');
    this.#authority = authority; this.#inventory = destinationInventory; this.#facts = eventFactsResolver; this.#adapter = adapter;
  }

  async #authorize(record, action) {
    try {
      const result = await this.#authority.authorize(record.grant, Object.freeze({ principal: record.principal,
        capability: 'automation.webhooks', action: `webhooks.${action}`, eventId: record.eventId,
        destination: Object.freeze({ id: record.request?.destinationId ?? record.destination?.id ?? null }),
        event: record.request?.event ? Object.freeze({ ...record.request.event }) : null }));
      if (result === false) throw new HostError('AUTOMATION_WEBHOOK_CAPABILITY_DENIED', 'denied', 403);
    } catch (error) { denied(error); }
  }

  deliver(value) {
    if (this.#closed) webhookFail('AUTOMATION_WEBHOOK_CLOSED', 'Webhook service is closed.', 409);
    const request = normalizeAutomationWebhookDeliverRequest(value);
    const key = `${request.principal}\u0000${request.idempotencyKey}`;
    const requestFingerprint = fingerprint(request);
    const prior = this.#records.get(key);
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) webhookFail('AUTOMATION_WEBHOOK_REPLAY_CONFLICT', 'Webhook idempotency key belongs to another event.', 409);
      return prior.promise;
    }
    if (this.#records.size >= AUTOMATION_WEBHOOK_MAX_EVENTS) webhookFail('AUTOMATION_WEBHOOK_EVENT_LIMIT', 'Webhook event limit has been reached.', 429);
    const record = { eventId: eventId(request, requestFingerprint), principal: request.principal, grant: request.grant,
      request, fingerprint: requestFingerprint, destination: null, eventFacts: null, envelope: null, attempts: 0, status: null,
      adapterDeliveryId: null, controller: new AbortController(), cancellationState: 'idle', cancellationPromise: null, promise: null };
    const run = this.#enqueue(() => this.#attempt(record));
    record.promise = run;
    this.#records.set(key, record);
    return run;
  }

  #enqueue(action) {
    const run = this.#serialized.then(action);
    this.#serialized = run.catch(() => {});
    return run;
  }

  async #attempt(record) {
    await this.#authorize(record, record.attempts === 0 ? 'deliver' : 'retry');
    if (record.status === 'delivered') return this.#publicReceipt(record);
    if (record.controller.signal.aborted) throw new HostError('AUTOMATION_WEBHOOK_CANCELLED', 'Webhook event was cancelled.', 499);
    if (record.status) return this.#publicReceipt(record);
    if (record.attempts >= AUTOMATION_WEBHOOK_MAX_ATTEMPTS) webhookFail('AUTOMATION_WEBHOOK_ATTEMPT_LIMIT', 'Webhook delivery attempt limit has been reached.', 429);
    if (record.adapterDeliveryId) {
      await this.#cancelRecord(record);
      record.adapterDeliveryId = null; record.cancellationState = 'idle';
    }
    if (!record.eventFacts) {
      const resolved = await this.#facts.resolve(record.request.event);
      record.eventFacts = normalizeTrustedWebhookEventFacts(resolved, record.request.event);
    }
    if (!record.destination) {
      const resolved = await this.#inventory.resolve(record.request.destinationId);
      record.destination = normalizeTrustedWebhookDestination(resolved, record.request.destinationId, record.request.event.type);
      record.envelope = createAutomationWebhookEnvelope(record.eventId, record.destination, record.eventFacts);
    }
    record.attempts += 1;
    let primary = null;
    try {
      const adapterValue = await this.#adapter.deliver(Object.freeze({ eventId: record.eventId,
        destination: record.destination, envelope: record.envelope, attempt: record.attempts, signal: record.controller.signal }));
      record.adapterDeliveryId = snapshotAdapterDeliveryId(adapterValue);
      const result = snapshotAdapterReceipt(adapterValue);
      record.status = checkedReceipt(result, record.envelope.envelopeDigest);
      if (record.controller.signal.aborted && record.status !== 'delivered') throw new HostError('AUTOMATION_WEBHOOK_CANCELLED', 'Webhook event was cancelled.', 499);
    } catch (error) { primary = error; }
    if (primary) {
      const failures = [primary];
      if (record.adapterDeliveryId) {
        try { await this.#cancelRecord(record); record.adapterDeliveryId = null; record.cancellationState = 'idle'; }
        catch (error) { failures.push(error); }
      }
      record.status = null;
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Webhook delivery and rollback failed.');
    }
    return this.#publicReceipt(record);
  }

  #publicReceipt(record) {
    return Object.freeze({ schemaVersion: 1, eventId: record.eventId, eventType: record.request.event.type,
      destination: Object.freeze({ ...record.destination }), envelopeDigest: record.envelope.envelopeDigest,
      attempt: record.attempts, status: record.status });
  }

  #find(action) {
    return [...this.#records.values()].find((record) => record.eventId === action.eventId
      && record.principal === action.principal && record.grant.grantId === action.grant.grantId);
  }

  async retry(value) {
    if (this.#closed) webhookFail('AUTOMATION_WEBHOOK_CLOSED', 'Webhook service is closed.', 409);
    const action = normalizeAutomationWebhookRetryRequest(value);
    const record = this.#find(action);
    if (!record) webhookFail('AUTOMATION_WEBHOOK_NOT_FOUND', 'Webhook event was not found.', 404);
    return this.#enqueue(() => this.#attempt(record));
  }

  #cancelRecord(record) {
    if (record.status === 'delivered' || !record.adapterDeliveryId || record.cancellationState === 'succeeded') return Promise.resolve();
    if (record.cancellationState === 'in-flight') return record.cancellationPromise;
    record.cancellationState = 'in-flight';
    const value = Object.freeze({ eventId: record.eventId, deliveryId: record.adapterDeliveryId,
      destination: record.destination, envelopeDigest: record.envelope.envelopeDigest });
    const run = Promise.resolve().then(() => this.#adapter.cancel(value)).then(() => { record.cancellationState = 'succeeded'; },
      (error) => { record.cancellationState = 'idle'; throw error; }).finally(() => {
      if (record.cancellationPromise === run) record.cancellationPromise = null;
    });
    record.cancellationPromise = run;
    return run;
  }

  async cancel(value) {
    const action = normalizeAutomationWebhookCancelRequest(value);
    const record = this.#find(action);
    if (!record) webhookFail('AUTOMATION_WEBHOOK_NOT_FOUND', 'Webhook event was not found.', 404);
    await this.#authorize(record, 'cancel');
    if (record.status === 'delivered') return Object.freeze({ schemaVersion: 1,
      eventId: record.eventId, cancelled: false, status: 'delivered' });
    record.controller.abort();
    await this.#enqueue(() => this.#cancelRecord(record));
    const delivered = record.status === 'delivered';
    return Object.freeze({ schemaVersion: 1, eventId: record.eventId, cancelled: !delivered,
      status: delivered ? 'delivered' : 'cancelled' });
  }

  async close() {
    this.#closed = true;
    if (this.#closeOperation) return this.#closeOperation;
    const run = (async () => {
      const records = [...this.#records.values()];
      for (const record of records) if (record.status !== 'delivered') record.controller.abort();
      await this.#serialized;
      const failures = [];
      for (const record of records) {
        try { await this.#cancelRecord(record); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Webhook close failed.');
    })();
    this.#closeOperation = run;
    try { await run; } finally { if (this.#closeOperation === run) this.#closeOperation = null; }
  }
}
