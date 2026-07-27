import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportContentComparisonReport,
  issueContentComparisonReport,
} from '../scripts/host/comparison-report.mjs';

function validReport() {
  return {
    kind: 'content',
    inputs: [
      {
        documentId: '11111111-1111-4111-8111-111111111111',
        sha256: 'a'.repeat(64),
        role: 'primary',
      },
      {
        documentId: '22222222-2222-4222-8222-222222222222',
        sha256: 'b'.repeat(64),
        role: 'secondary',
      },
    ],
    stats: {
      added: 0,
      deleted: 0,
      unchanged: 0,
      changed: 0,
      leftPages: 1,
      rightPages: 1,
    },
    pages: [{
      page: 1,
      leftPresent: true,
      rightPresent: true,
      runs: [],
      stats: { added: 0, deleted: 0, unchanged: 0 },
    }],
  };
}

test('comparison export checks host issuance before reading hostile objects', () => {
  let calls = 0;
  const report = {
    kind: 'pixel',
    toJSON() {
      calls += 1;
      return { kind: 'content' };
    },
  };
  assert.throws(
    () => exportContentComparisonReport(report),
    { code: 'INVALID_REPORT', status: 502 },
  );
  assert.equal(calls, 0);
});

test('comparison issuance rejects nested accessors without invoking them', () => {
  let calls = 0;
  const report = validReport();
  const stats = { ...report.stats };
  Object.defineProperty(stats, 'added', {
    enumerable: true,
    get() {
      calls += 1;
      return 0;
    },
  });
  Object.freeze(stats);
  Object.freeze(report.pages);
  Object.freeze(report.inputs);
  Object.freeze(report);
  assert.throws(
    () => issueContentComparisonReport({ ...report, stats }),
    { code: 'INVALID_REPORT', status: 502 },
  );
  assert.equal(calls, 0);
});

test('comparison issuance rejects proxies without invoking traps', () => {
  let calls = 0;
  const report = new Proxy(validReport(), {
    get() {
      calls += 1;
      throw new Error('trap must not run');
    },
  });
  assert.throws(
    () => issueContentComparisonReport(report),
    { code: 'INVALID_REPORT', status: 502 },
  );
  assert.equal(calls, 0);
});
