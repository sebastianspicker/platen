import assert from 'node:assert/strict';
import test from 'node:test';
import { queryAnnotations } from '../scripts/host/domains/review-forms-review-query.mjs';

function snapshot() {
  return {
    namespaces: {
      annotations: [
        { id: 'zeta', type: 'comment', status: 'open', page: 2, author: 'Ada', text: 'Alpha review', customStatus: '', createdAt: '2026-07-18T12:00:00.000Z', properties: { color: 'yellow' } },
        { id: 'beta', type: 'note', status: 'inProgress', page: 1, author: 'Bea', text: 'Needle review', createdAt: '2026-07-17T12:00:00.000Z' },
        { id: 'alpha', type: 'comment', status: 'custom', page: 1, author: 'Ada', text: 'Escalated', customStatus: 'Needs Legal', createdAt: '2026-07-18T12:00:00.000Z' },
        { id: 'delta', type: 'stamp', status: 'resolved', page: 2, author: 'Zed', text: 'Approved', createdAt: '2026-07-18T12:00:00.000Z' },
      ],
    },
  };
}

function ids(records) { return records.map((record) => record.id); }

test('queryAnnotations defaults to createdAt ascending with an id tiebreak', () => {
  assert.deepEqual(ids(queryAnnotations(snapshot())), ['beta', 'alpha', 'delta', 'zeta']);
});

test('queryAnnotations combines status, type, and case-insensitive text search across custom statuses', () => {
  const result = queryAnnotations(snapshot(), { status: 'custom', type: 'comment', search: 'LEGAL' });
  assert.deepEqual(ids(result), ['alpha']);
});

test('queryAnnotations covers every sort and direction axis, including descending reversal', () => {
  const expectedAscending = {
    createdAt: ['beta', 'alpha', 'delta', 'zeta'],
    page: ['alpha', 'beta', 'delta', 'zeta'],
    status: ['alpha', 'beta', 'zeta', 'delta'],
    type: ['alpha', 'zeta', 'beta', 'delta'],
    author: ['alpha', 'zeta', 'beta', 'delta'],
  };
  for (const [sortBy, ascending] of Object.entries(expectedAscending)) {
    assert.deepEqual(ids(queryAnnotations(snapshot(), { sortBy })), ascending, `${sortBy} ascending`);
    assert.deepEqual(ids(queryAnnotations(snapshot(), { sortBy, direction: 'desc' })), [...ascending].reverse(), `${sortBy} descending`);
  }
});

test('queryAnnotations covers every grouping axis and preserves Object.groupBy output shape', () => {
  const groupedByStatus = queryAnnotations(snapshot(), { groupBy: 'status' });
  assert.equal(Object.getPrototypeOf(groupedByStatus), null);
  assert.deepEqual(Object.keys(groupedByStatus), ['inProgress', 'custom', 'resolved', 'open']);
  assert.deepEqual(ids(groupedByStatus.open), ['zeta']);

  const expectedKeys = {
    type: ['note', 'comment', 'stamp'],
    author: ['Bea', 'Ada', 'Zed'],
    page: ['1', '2'],
  };
  for (const [groupBy, keys] of Object.entries(expectedKeys)) {
    const grouped = queryAnnotations(snapshot(), { groupBy });
    assert.equal(Object.getPrototypeOf(grouped), null, `${groupBy} uses Object.groupBy`);
    assert.deepEqual(Object.keys(grouped), keys, `${groupBy} groups sorted records`);
  }
  assert.ok(Array.isArray(queryAnnotations(snapshot(), { groupBy: 'none' })));
});

test('queryAnnotations returns isolated JSON copies', () => {
  const source = snapshot();
  const result = queryAnnotations(source);
  result[0].properties = { color: 'blue' };
  result.at(-1).properties.color = 'red';
  assert.equal(source.namespaces.annotations[0].properties.color, 'yellow');
  assert.equal(source.namespaces.annotations[1].properties, undefined);
});

test('queryAnnotations preserves validation codes and their ordering', () => {
  const source = snapshot();
  assert.throws(() => queryAnnotations(source, { search: 42, status: 'invalid' }), { code: 'INVALID_INPUT' });
  assert.throws(() => queryAnnotations(source, { status: 'invalid', type: 'invalid' }), { code: 'INVALID_STATUS' });
  assert.throws(() => queryAnnotations(source, { type: 'invalid', groupBy: 'invalid' }), { code: 'INVALID_ANNOTATION_TYPE' });
  assert.throws(() => queryAnnotations(source, { groupBy: 'invalid' }), { code: 'INVALID_QUERY' });
  assert.throws(() => queryAnnotations(source, { sortBy: 'invalid' }), { code: 'INVALID_QUERY' });
  assert.throws(() => queryAnnotations(source, { direction: 'sideways' }), { code: 'INVALID_QUERY' });
});
