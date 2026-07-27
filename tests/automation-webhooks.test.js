import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutomationWebhookService, automationWebhookEventId,
} from '../scripts/host/automation/automation-webhook-service.mjs';

const grant = Object.freeze({ grantId: 'grant_webhook_1', principal: 'caller.one' });
const destination = Object.freeze({ id: 'destination_1', identityDigest: 'd'.repeat(64), status: 'ready',
  eventTypes: Object.freeze(['source.stored', 'job.completed', 'output.created']) });

function event(type = 'output.created') {
  return { type, sourceId: 'source_1', jobId: type === 'source.stored' ? null : 'job_1',
    outputId: type === 'output.created' ? 'output_1' : null };
}

function trustedFacts(type = 'output.created') {
  return { type, source: { id: 'source_1', sha256: 'a'.repeat(64), size: 100 },
    job: type === 'source.stored' ? null : { id: 'job_1', operation: 'pdf.ocr', status: 'completed' },
    output: type === 'output.created' ? { id: 'output_1', mediaType: 'application/pdf', sha256: 'b'.repeat(64), size: 120 } : null };
}

function request(overrides = {}) {
  return { principal: grant.principal, grant, destinationId: destination.id,
    idempotencyKey: 'event-1', event: event(), ...overrides };
}

function setup({ resolve = null, factsResolve = null, deliver = null, cancel = null, authorize = null } = {}) {
  const calls = { authority: [], resolve: [], facts: [], deliver: [], cancel: [] };
  const destinationInventory = { async resolve(id) { calls.resolve.push(id); return resolve ? resolve(id) : destination; } };
  const eventFactsResolver = { async resolve(reference) { calls.facts.push(reference);
    return factsResolve ? factsResolve(reference) : trustedFacts(reference.type); } };
  const adapter = {
    async deliver(value) { calls.deliver.push(value); return deliver ? deliver(value, calls) : {
      deliveryId: 'delivery_1', envelopeDigest: value.envelope.envelopeDigest, status: 'accepted' }; },
    async cancel(value) { calls.cancel.push(value); if (cancel) return cancel(value, calls); },
  };
  const authority = { async authorize(value, context) { calls.authority.push({ value, context });
    if (authorize) return authorize(value, context, calls); } };
  return { service: new AutomationWebhookService({ authority, destinationInventory, eventFactsResolver, adapter }), calls };
}

test('webhook delivers one canonical digest-bound envelope to a trusted destination', async () => {
  const state = setup();
  const result = await state.service.deliver(request());
  assert.equal(result.eventId, automationWebhookEventId(request()));
  assert.equal(result.destination.id, destination.id);
  assert.equal(result.attempt, 1);
  assert.equal(Object.hasOwn(result, 'deliveryId'), false);
  assert.equal(state.calls.deliver.length, 1);
  const delivered = state.calls.deliver[0];
  assert.equal(delivered.destination.identityDigest, destination.identityDigest);
  assert.match(delivered.envelope.payloadDigest, /^[a-f0-9]{64}$/u);
  assert.match(delivered.envelope.envelopeDigest, /^[a-f0-9]{64}$/u);
  assert.equal(delivered.envelope.signatureInput, `sha256=${delivered.envelope.envelopeDigest}`);
  assert.deepEqual(Reflect.ownKeys(delivered.envelope.payload), ['schemaVersion', 'eventId', 'type', 'source', 'job', 'output']);
  assert.deepEqual(delivered.envelope.payload.source, trustedFacts().source);
  assert.equal(JSON.stringify(delivered).includes('url'), false);
  assert.equal(JSON.stringify(delivered).includes('secret'), false);
  await state.service.close();
});

test('default inventory and adapter fail closed without network delivery', async () => {
  const authority = { async authorize() {} };
  const service = new AutomationWebhookService({ authority });
  await assert.rejects(service.deliver(request()), { code: 'AUTOMATION_WEBHOOK_EVENT_FACTS_UNAVAILABLE' });
  await service.close();
  const adapterOnly = new AutomationWebhookService({ authority,
    eventFactsResolver: { async resolve(reference) { return trustedFacts(reference.type); } },
    destinationInventory: { async resolve() { return destination; } } });
  await assert.rejects(adapterOnly.deliver(request()), { code: 'AUTOMATION_WEBHOOK_UNAVAILABLE' });
  await adapterOnly.close();
});

test('input rejects URLs, headers, arbitrary bodies, accessors, proxies, and mismatched metadata', async () => {
  const state = setup();
  assert.throws(() => state.service.deliver({ ...request(), url: 'https://example.test' }), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  assert.throws(() => state.service.deliver({ ...request(), headers: {} }), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  assert.throws(() => state.service.deliver({ ...request(), body: 'arbitrary' }), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  assert.throws(() => state.service.deliver(new Proxy(request(), {})), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  const accessor = request();
  Object.defineProperty(accessor, 'event', { enumerable: true, get() { throw new Error('trap'); } });
  assert.throws(() => state.service.deliver(accessor), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  assert.throws(() => state.service.deliver(request({ event: { ...event('source.stored'), outputId: 'output_1' } })), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  assert.equal(state.calls.resolve.length, 0); assert.equal(state.calls.deliver.length, 0);
  await state.service.close();
});

test('trusted destination identity and event allowlist are enforced before adapter delivery', async () => {
  const drift = setup({ resolve: () => ({ ...destination, id: 'destination_2' }) });
  await assert.rejects(drift.service.deliver(request()), { code: 'AUTOMATION_WEBHOOK_DESTINATION_INVALID' });
  const denied = setup({ resolve: () => ({ ...destination, eventTypes: ['source.stored'] }) });
  await assert.rejects(denied.service.deliver(request()), { code: 'AUTOMATION_WEBHOOK_EVENT_DENIED' });
  assert.equal(drift.calls.deliver.length, 0); assert.equal(denied.calls.deliver.length, 0);
  await drift.service.close(); await denied.service.close();
});

test('caller cannot assert provenance and trusted facts must exactly bind every requested identifier', async () => {
  const state = setup();
  assert.throws(() => state.service.deliver(request({ event: { ...event(), sha256: 'f'.repeat(64) } })), { code: 'INVALID_AUTOMATION_WEBHOOK' });
  for (const [index, factsResolve] of [
    [1, () => ({ ...trustedFacts(), source: { ...trustedFacts().source, id: 'source_invented' } })],
    [2, () => ({ ...trustedFacts(), job: { ...trustedFacts().job, id: 'job_invented' } })],
    [3, () => ({ ...trustedFacts(), output: { ...trustedFacts().output, id: 'output_invented' } })],
    [4, () => ({ ...trustedFacts(), source: { ...trustedFacts().source, size: 0 } })],
  ]) {
    const forged = setup({ factsResolve });
    await assert.rejects(forged.service.deliver(request({ idempotencyKey: `facts-${index}` })), { code: 'AUTOMATION_WEBHOOK_EVENT_FACTS_INVALID' });
    assert.equal(forged.calls.resolve.length, 0);
    assert.equal(forged.calls.deliver.length, 0);
    await forged.service.close();
  }
  await state.service.close();
});

test('replay shares delivery while conflicting idempotency is rejected', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ deliver: async (value) => { await gate; return { deliveryId: 'delivery_1', envelopeDigest: value.envelope.envelopeDigest, status: 'accepted' }; } });
  const first = state.service.deliver(request());
  const second = state.service.deliver(request());
  assert.strictEqual(first, second);
  assert.throws(() => state.service.deliver(request({ event: event('job.completed') })), { code: 'AUTOMATION_WEBHOOK_REPLAY_CONFLICT' });
  release();
  assert.strictEqual(await first, await second);
  assert.equal(state.calls.deliver.length, 1);
  await state.service.close();
});

test('transient failures retry serially within the fixed attempt bound and successful delivery deduplicates', async () => {
  let attempts = 0;
  const state = setup({ deliver: async (value) => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('transient'), { code: 'TRANSIENT' });
    return { deliveryId: 'delivery_3', envelopeDigest: value.envelope.envelopeDigest, status: 'delivered' };
  } });
  const value = request();
  await assert.rejects(state.service.deliver(value), { code: 'TRANSIENT' });
  const action = { principal: grant.principal, grant, eventId: automationWebhookEventId(value) };
  const firstRetry = state.service.retry(action);
  const secondRetry = state.service.retry(action);
  await assert.rejects(firstRetry, { code: 'TRANSIENT' });
  const receipt = await secondRetry;
  assert.equal(receipt.attempt, 3); assert.equal(receipt.status, 'delivered');
  assert.deepEqual(await state.service.retry(action), receipt);
  assert.equal(attempts, 3);
  await state.service.close();
});

test('terminal retry reauthorizes before returning and revoked authority suppresses adapter replay', async () => {
  let revoked = false;
  const state = setup({ authorize: (_grant, context) => {
    if (revoked && context.action === 'webhooks.retry') throw new Error('revoked');
  }, deliver: async (value) => ({ deliveryId: 'delivery_terminal', envelopeDigest: value.envelope.envelopeDigest, status: 'delivered' }) });
  const value = request();
  await state.service.deliver(value);
  revoked = true;
  await assert.rejects(state.service.retry({ principal: grant.principal, grant,
    eventId: automationWebhookEventId(value) }), { code: 'AUTOMATION_WEBHOOK_CAPABILITY_DENIED', status: 403 });
  assert.equal(state.calls.deliver.length, 1);
  assert.equal(state.calls.cancel.length, 0);
  await state.service.close();
});

test('delivery attempts stop at the fixed bound without a fourth adapter call', async () => {
  const failure = Object.assign(new Error('offline'), { code: 'OFFLINE' });
  const state = setup({ deliver: async () => { throw failure; } });
  const value = request();
  const action = { principal: grant.principal, grant, eventId: automationWebhookEventId(value) };
  await assert.rejects(state.service.deliver(value), (error) => error === failure);
  await assert.rejects(state.service.retry(action), (error) => error === failure);
  await assert.rejects(state.service.retry(action), (error) => error === failure);
  await assert.rejects(state.service.retry(action), { code: 'AUTOMATION_WEBHOOK_ATTEMPT_LIMIT', status: 429 });
  assert.equal(state.calls.deliver.length, 3);
  await state.service.close();
});

test('forged adapter status or digest rolls back the exact observed side effect', async () => {
  for (const [index, expectedDeliveryId, forged] of [
    [1, 'delivery_bad_status', (value) => ({ deliveryId: 'delivery_bad_status', envelopeDigest: value.envelope.envelopeDigest, status: 'unknown' })],
    [2, 'delivery_bad_digest', () => ({ deliveryId: 'delivery_bad_digest', envelopeDigest: '0'.repeat(64), status: 'accepted' })],
    [3, 'delivery_extra_field', (value) => ({ deliveryId: 'delivery_extra_field', envelopeDigest: value.envelope.envelopeDigest, status: 'accepted', body: 'forged' })],
  ]) {
    const state = setup({ deliver: forged });
    const value = request({ idempotencyKey: `forged-${index}` });
    await assert.rejects(state.service.deliver(value), { code: 'AUTOMATION_WEBHOOK_ADAPTER_INVALID' });
    assert.equal(state.calls.cancel.length, 1);
    assert.equal(state.calls.cancel[0].deliveryId, expectedDeliveryId);
    assert.equal(state.calls.cancel[0].eventId, automationWebhookEventId(value));
    assert.equal(state.calls.cancel[0].destination.identityDigest, destination.identityDigest);
    await state.service.close();
  }
});

test('authority denial precedes destination resolution and adapter delivery', async () => {
  const calls = { facts: 0, resolve: 0, deliver: 0 };
  const service = new AutomationWebhookService({ authority: { async authorize() { throw new Error('denied'); } },
    eventFactsResolver: { async resolve() { calls.facts += 1; return trustedFacts(); } },
    destinationInventory: { async resolve() { calls.resolve += 1; return destination; } },
    adapter: { async deliver() { calls.deliver += 1; }, async cancel() {} } });
  await assert.rejects(service.deliver(request()), { code: 'AUTOMATION_WEBHOOK_CAPABILITY_DENIED', status: 403 });
  assert.deepEqual(calls, { facts: 0, resolve: 0, deliver: 0 });
  await service.close();
});

test('cancellation serializes behind delivery and close does not duplicate successful cancellation', async () => {
  let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const state = setup({ deliver: async (value) => { entered(); await gate;
    return { deliveryId: 'delivery_1', envelopeDigest: value.envelope.envelopeDigest, status: 'accepted' }; } });
  const value = request();
  const delivery = state.service.deliver(value);
  await started;
  const cancellation = state.service.cancel({ principal: grant.principal, grant, eventId: automationWebhookEventId(value) });
  release();
  await assert.rejects(delivery, { code: 'AUTOMATION_WEBHOOK_CANCELLED' });
  assert.equal((await cancellation).cancelled, true);
  assert.equal(state.calls.cancel.length, 1);
  await state.service.close();
  assert.equal(state.calls.cancel.length, 1);
});

test('delivered events are terminal and explicit cancel or close never invokes adapter cancellation', async () => {
  const state = setup({ deliver: async (value) => ({ deliveryId: 'delivery_terminal',
    envelopeDigest: value.envelope.envelopeDigest, status: 'delivered' }) });
  const value = request();
  const delivered = await state.service.deliver(value);
  const result = await state.service.cancel({ principal: grant.principal, grant,
    eventId: automationWebhookEventId(value) });
  assert.deepEqual(result, { schemaVersion: 1, eventId: automationWebhookEventId(value),
    cancelled: false, status: 'delivered' });
  assert.equal(state.calls.cancel.length, 0);
  const retried = await state.service.retry({ principal: grant.principal, grant,
    eventId: automationWebhookEventId(value) });
  assert.deepEqual(retried, delivered);
  assert.equal(state.calls.deliver.length, 1);
  await state.service.close();
  assert.equal(state.calls.cancel.length, 0);
});

test('close serializes adapter cancellation across distinct delivered events', async () => {
  let active = 0; let maximumActive = 0;
  const state = setup({ deliver: async (value, calls) => ({ deliveryId: `delivery_${calls.deliver.length}`,
    envelopeDigest: value.envelope.envelopeDigest, status: 'accepted' }), cancel: async () => {
    active += 1; maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  } });
  await state.service.deliver(request());
  await state.service.deliver(request({ idempotencyKey: 'event-2', event: event('job.completed') }));
  await state.service.close();
  assert.equal(state.calls.cancel.length, 2);
  assert.equal(maximumActive, 1);
});
