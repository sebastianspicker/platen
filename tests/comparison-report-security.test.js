import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportContentComparisonReport,
  issueContentComparisonReport,
  validateContentComparisonReceipt,
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

function asymmetricReport() {
  const report = validReport();
  report.pages = [
    {
      page: 1, leftPresent: true, rightPresent: true,
      runs: [{ kind: 'added', text: 'left-only', count: 2 }, { kind: 'unchanged', text: 'same', count: 1 }],
      stats: { added: 2, deleted: 0, unchanged: 1 },
    },
    {
      page: 2, leftPresent: false, rightPresent: true,
      runs: [{ kind: 'deleted', text: 'right-only', count: 3 }, { kind: 'unchanged', text: 'again', count: 3 }],
      stats: { added: 0, deleted: 3, unchanged: 3 },
    },
  ];
  report.stats = { added: 2, deleted: 3, unchanged: 4, changed: 5, leftPages: 1, rightPages: 2 };
  return report;
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

test('comparison issuance accepts dense and null-prototype data, while rejecting sparse arrays', () => {
  const report = validReport();
  report.stats = Object.assign(Object.create(null), report.stats);
  report.pages[0].stats = Object.assign(Object.create(null), report.pages[0].stats);
  const issued = issueContentComparisonReport(report);
  assert.equal(issued.kind, 'content');

  const sparse = validReport();
  sparse.pages = new Array(1);
  assert.throws(
    () => issueContentComparisonReport(sparse),
    { code: 'INVALID_REPORT', status: 502 },
  );
});

test('comparison issuance rejects nested accessors and proxies without invoking traps', () => {
  let accessorCalls = 0;
  const accessor = validReport();
  Object.defineProperty(accessor.pages[0], 'runs', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return [];
    },
  });
  assert.throws(
    () => issueContentComparisonReport(accessor),
    { code: 'INVALID_REPORT', status: 502 },
  );
  assert.equal(accessorCalls, 0);

  let proxyCalls = 0;
  const proxied = validReport();
  proxied.pages[0].stats = new Proxy(proxied.pages[0].stats, {
    getOwnPropertyDescriptor() {
      proxyCalls += 1;
      throw new Error('trap must not run');
    },
  });
  assert.throws(
    () => issueContentComparisonReport(proxied),
    { code: 'INVALID_REPORT', status: 502 },
  );
  assert.equal(proxyCalls, 0);
});

test('comparison snapshot distinguishes cycles from shared non-cycle references', () => {
  const cycle = validReport();
  cycle.extra = cycle;
  assert.throws(
    () => issueContentComparisonReport(cycle),
    { code: 'INVALID_REPORT', status: 502 },
  );

  const shared = validReport();
  const metadata = { retained: true };
  shared.firstMetadata = metadata;
  shared.secondMetadata = metadata;
  assert.equal(issueContentComparisonReport(shared).kind, 'content');
});

test('comparison snapshot enforces global item, depth, and text limits', () => {
  const tooManyItems = validReport();
  tooManyItems.extra = Array.from({ length: 200_000 }, () => null);
  assert.throws(
    () => issueContentComparisonReport(tooManyItems),
    { code: 'COMPARISON_REPORT_LIMIT', status: 413 },
  );

  const tooDeep = validReport();
  let nested = {};
  tooDeep.extra = nested;
  for (let index = 0; index <= 12; index += 1) {
    nested.next = {};
    nested = nested.next;
  }
  assert.throws(
    () => issueContentComparisonReport(tooDeep),
    { code: 'COMPARISON_REPORT_LIMIT', status: 413 },
  );

  const tooMuchText = validReport();
  tooMuchText.extra = 'x'.repeat((16 * 1024 * 1024) + 1);
  assert.throws(
    () => issueContentComparisonReport(tooMuchText),
    { code: 'COMPARISON_REPORT_LIMIT', status: 413 },
  );
});

test('comparison validation rejects page, aggregate count, and aggregate metadata mismatches', () => {
  const pageMismatch = validReport();
  pageMismatch.pages[0].stats.added = 1;
  assert.throws(
    () => validateContentComparisonReceipt(pageMismatch),
    { code: 'INVALID_REPORT', message: 'Content comparison page counts do not match its token runs.', status: 502 },
  );

  const aggregateCountMismatch = validReport();
  aggregateCountMismatch.stats.added = 1;
  assert.throws(
    () => validateContentComparisonReceipt(aggregateCountMismatch),
    { code: 'INVALID_REPORT', message: 'Content comparison aggregate counts are inconsistent.', status: 502 },
  );

  const aggregateMetadataMismatch = validReport();
  aggregateMetadataMismatch.stats.changed = 1;
  assert.throws(
    () => validateContentComparisonReceipt(aggregateMetadataMismatch),
    { code: 'INVALID_REPORT', message: 'Content comparison aggregate metadata is inconsistent.', status: 502 },
  );
});

test('comparison issuance freezes the stable graph and exports only its exact identity', () => {
  const issued = issueContentComparisonReport(validReport());
  assert.ok(Object.isFrozen(issued));
  assert.ok(Object.isFrozen(issued.inputs));
  assert.ok(Object.isFrozen(issued.inputs[0]));
  assert.ok(Object.isFrozen(issued.stats));
  assert.ok(Object.isFrozen(issued.pages));
  assert.ok(Object.isFrozen(issued.pages[0]));
  assert.ok(Object.isFrozen(issued.pages[0].runs));
  assert.ok(Object.isFrozen(issued.pages[0].stats));
  assert.throws(
    () => exportContentComparisonReport({ ...issued }),
    { code: 'INVALID_REPORT', status: 502 },
  );
});

test('comparison JSON and CSV exports retain their exact stable bytes', () => {
  const issued = issueContentComparisonReport(validReport());
  const json = exportContentComparisonReport(issued, { format: 'json' });
  const csv = exportContentComparisonReport(issued, { format: 'csv' });
  assert.ok(Object.isFrozen(json));
  assert.ok(Object.isFrozen(csv));
  assert.equal(json.data, `{
  "kind": "content",
  "inputs": [
    {
      "sha256": "${'a'.repeat(64)}",
      "role": "primary"
    },
    {
      "sha256": "${'b'.repeat(64)}",
      "role": "secondary"
    }
  ],
  "stats": {
    "added": 0,
    "deleted": 0,
    "unchanged": 0,
    "changed": 0,
    "leftPages": 1,
    "rightPages": 1
  },
  "pages": [
    {
      "page": 1,
      "leftPresent": true,
      "rightPresent": true,
      "runs": [],
      "stats": {
        "added": 0,
        "deleted": 0,
        "unchanged": 0
      }
    }
  ]
}
`);
  assert.equal(csv.data, [
    '"primarySha256","secondarySha256","kind","page","status","added","deleted","unchanged","changedPixels","comparedPixels"',
    `"${'a'.repeat(64)}","${'b'.repeat(64)}","content","1","","0","0","0","",""`,
    '',
  ].join('\n'));
});

test('comparison source bindings reject malformed hashes, reversed roles, and malformed issuance IDs', () => {
  const malformedHash = validReport();
  malformedHash.inputs[0].sha256 = 'not-a-sha';
  const reversedRoles = validReport();
  [reversedRoles.inputs[0].role, reversedRoles.inputs[1].role] = ['secondary', 'primary'];
  const malformedId = validReport();
  malformedId.inputs[1].documentId = 'not-a-document-id';
  for (const report of [malformedHash, reversedRoles, malformedId]) {
    assert.throws(
      () => issueContentComparisonReport(report),
      { code: 'INVALID_REPORT', message: 'Comparison source bindings are invalid or out of order.', status: 502 },
    );
  }
});

test('comparison receipt validation strips issuance identity and cannot authorize export', () => {
  const receipt = validateContentComparisonReceipt(validReport());
  assert.deepEqual(receipt.inputs.map((input) => Object.keys(input)), [
    ['sha256', 'role'], ['sha256', 'role'],
  ]);
  assert.throws(
    () => exportContentComparisonReport(receipt),
    { code: 'INVALID_REPORT', message: 'Comparison export requires an exact host-issued content report.', status: 502 },
  );
});

test('comparison snapshot rejects non-native, subclass, null-prototype arrays, symbols, and hidden extras', () => {
  class PageArray extends Array {}
  const fakeArray = validReport();
  fakeArray.pages = Object.create(Array.prototype);
  fakeArray.pages.length = 1;
  const subclassArray = validReport();
  subclassArray.pages = new PageArray(...subclassArray.pages);
  const nullPrototypeArray = validReport();
  Object.setPrototypeOf(nullPrototypeArray.pages, null);
  const symbolExtra = validReport();
  symbolExtra[Symbol('extra')] = true;
  const hiddenExtra = validReport();
  Object.defineProperty(hiddenExtra, 'hidden', { value: true });
  for (const report of [fakeArray, subclassArray, nullPrototypeArray, symbolExtra, hiddenExtra]) {
    assert.throws(() => issueContentComparisonReport(report), { code: 'INVALID_REPORT', status: 502 });
  }
});

test('comparison snapshot accepts exact global item, depth, and text limits', () => {
  const exactItems = validReport();
  exactItems.extra = Array.from({ length: 199_971 }, () => null);
  assert.equal(issueContentComparisonReport(exactItems).kind, 'content');

  const exactDepth = validReport();
  let nested = exactDepth.extra = {};
  for (let depth = 1; depth < 12; depth += 1) nested = nested.next = {};
  assert.equal(issueContentComparisonReport(exactDepth).kind, 'content');

  const exactText = validReport();
  exactText.extra = 'x'.repeat((16 * 1024 * 1024) - 223);
  assert.equal(issueContentComparisonReport(exactText).kind, 'content');
});

test('comparison asymmetric non-zero reports retain their exact JSON and CSV projections', () => {
  const issued = issueContentComparisonReport(asymmetricReport());
  const expected = {
    kind: 'content',
    inputs: [{ sha256: 'a'.repeat(64), role: 'primary' }, { sha256: 'b'.repeat(64), role: 'secondary' }],
    stats: { added: 2, deleted: 3, unchanged: 4, changed: 5, leftPages: 1, rightPages: 2 },
    pages: [
      { page: 1, leftPresent: true, rightPresent: true, runs: [{ kind: 'added', text: 'left-only', count: 2 }, { kind: 'unchanged', text: 'same', count: 1 }], stats: { added: 2, deleted: 0, unchanged: 1 } },
      { page: 2, leftPresent: false, rightPresent: true, runs: [{ kind: 'deleted', text: 'right-only', count: 3 }, { kind: 'unchanged', text: 'again', count: 3 }], stats: { added: 0, deleted: 3, unchanged: 3 } },
    ],
  };
  assert.equal(exportContentComparisonReport(issued).data, `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal(exportContentComparisonReport(issued, { format: 'csv' }).data, [
    '"primarySha256","secondarySha256","kind","page","status","added","deleted","unchanged","changedPixels","comparedPixels"',
    `"${'a'.repeat(64)}","${'b'.repeat(64)}","content","1","","2","0","1","",""`,
    `"${'a'.repeat(64)}","${'b'.repeat(64)}","content","2","","0","3","3","",""`,
    '',
  ].join('\n'));
});
