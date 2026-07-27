import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_OPERATION_REGISTRY } from '../scripts/host/domain-facade.mjs';
import { domainPayloadTemplate, domainPayloadValue } from '../src/core/domain-templates.js';

test('every supported workflow operation receives a JSON-object starter payload', () => {
  let count = 0;
  for (const [group, operations] of Object.entries(DOMAIN_OPERATION_REGISTRY)) {
    for (const [operation, entry] of Object.entries(operations)) {
      if (!entry.supported) continue;
      const payload = domainPayloadTemplate(group, operation, { revision: 7, documentDigest: 'd'.repeat(64) });
      const parsed = JSON.parse(payload);
      assert.equal(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), true, `${group}.${operation}`);
      assert.doesNotMatch(payload, /undefined|__proto__|constructor/);
      count += 1;
    }
  }
  assert.equal(count, 54);
});

test('starter payloads include current revisions and immutable source digests where required', () => {
  assert.equal(domainPayloadValue('review', 'createAnnotation', { revision: 9 }).options.expectedRevision, 9);
  assert.equal(domainPayloadValue('review', 'queryAnnotations', { revision: 9 }).options, undefined);
  const signing = domainPayloadValue('signing', 'createElectronicIntent', {
    revision: 3, documentDigest: 'f'.repeat(64),
  });
  assert.equal(signing.input.documentDigest, 'f'.repeat(64));
  assert.equal(signing.options.expectedRevision, 3);
});
