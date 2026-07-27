import assert from 'node:assert/strict';
import test from 'node:test';
import {
  movePageNavigation,
  recordPageNavigation,
  resetPageNavigation,
  transitionPageNavigation,
} from '../src/core/navigation-history.js';

test('page navigation history records branches, bounds entries, and moves deterministically', () => {
  let state = recordPageNavigation([1], 0, 2);
  state = recordPageNavigation(state.history, state.index, 3);
  assert.deepEqual(state, { history: [1, 2, 3], index: 2, page: 3 });
  const back = movePageNavigation(state.history, state.index, -1);
  assert.deepEqual(back, { history: [1, 2, 3], index: 1, page: 2 });
  const branched = recordPageNavigation(back.history, back.index, 4);
  assert.deepEqual(branched, { history: [1, 2, 4], index: 2, page: 4 });
  const bounded = recordPageNavigation(branched.history, branched.index, 5, { limit: 3 });
  assert.deepEqual(bounded.history, [2, 4, 5]);
  assert.equal(movePageNavigation(bounded.history, 0, -1), null);
  assert.throws(() => recordPageNavigation([1], 0, 0), /positive integer/);
});

test('page navigation history is immutable, deduplicates selections, and fails safely on malformed state', () => {
  const history = [1, 2];
  const duplicate = recordPageNavigation(history, 1, 2);
  assert.deepEqual(duplicate, { history: [1, 2], index: 1, page: 2 });
  assert.notEqual(duplicate.history, history);
  assert.ok(Object.isFrozen(duplicate));
  assert.ok(Object.isFrozen(duplicate.history));
  assert.equal(movePageNavigation([1, 0], 0, 1), null);
  assert.equal(movePageNavigation([1], 0, 1), null);
  assert.deepEqual(recordPageNavigation([1, 0], 1, 3), { history: [3], index: 0, page: 3 });
});

test('page navigation history evicts oldest entries at the production limit', () => {
  let state = recordPageNavigation([1], 0, 1);
  for (let page = 2; page <= 101; page += 1) state = recordPageNavigation(state.history, state.index, page);
  assert.equal(state.history.length, 100);
  assert.equal(state.history[0], 2);
  assert.equal(state.history.at(-1), 101);
  assert.equal(state.index, 99);
});

test('same-page selection cannot bypass default or custom history limits', () => {
  const oversized = Array.from({ length: 101 }, (_, index) => index + 1);
  assert.deepEqual(recordPageNavigation(oversized, 100, 101), {
    history: oversized.slice(1), index: 99, page: 101,
  });
  assert.deepEqual(recordPageNavigation([1, 2, 3], 2, 3, { limit: 2 }), {
    history: [2, 3], index: 1, page: 3,
  });
});

test('application page transitions validate document bounds, history moves, branching, and lifecycle resets', () => {
  const reset = resetPageNavigation();
  assert.deepEqual(reset, { history: [1], index: 0, page: 1 });
  assert.ok(Object.isFrozen(reset));
  assert.ok(Object.isFrozen(reset.history));

  const selected = transitionPageNavigation(reset.history, reset.index, 1, 2, { pageCount: 3 });
  assert.deepEqual(selected, { changed: true, history: [1, 2], index: 1, page: 2 });
  const back = transitionPageNavigation(selected.history, selected.index, 2, 1, {
    pageCount: 3, record: false, targetIndex: 0,
  });
  assert.deepEqual(back, { changed: true, history: [1, 2], index: 0, page: 1 });
  assert.deepEqual(transitionPageNavigation(back.history, back.index, 1, 1, { pageCount: 3 }), {
    changed: false, history: [1, 2], index: 0, page: 1,
  });
  assert.deepEqual(transitionPageNavigation(back.history, back.index, 1, 3, { pageCount: 3 }), {
    changed: true, history: [1, 3], index: 1, page: 3,
  });
  assert.equal(transitionPageNavigation([1], 0, 1, 2, { pageCount: 1 }), null);
  assert.equal(transitionPageNavigation([1, 2], 0, 1, 2, {
    pageCount: 2, record: false, targetIndex: 0,
  }), null);
  assert.deepEqual(resetPageNavigation(), reset);
});
