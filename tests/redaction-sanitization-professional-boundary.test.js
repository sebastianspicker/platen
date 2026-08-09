import assert from 'node:assert/strict';
import test from 'node:test';
import { handlers } from '../scripts/host/professional-capability/redaction-sanitization.mjs';

test('dedicated redaction and selective sanitization workflows are not exposed through generic handlers', () => {
  assert.equal(handlers['redaction.preview'], undefined);
  assert.equal(handlers['redaction.batch'], undefined);
  assert.equal(handlers['redaction.find-patterns'], undefined);
  assert.equal(handlers['redaction.overlay-labels'], undefined);
  assert.equal(handlers['sanitize.selective-content'], undefined);
});
