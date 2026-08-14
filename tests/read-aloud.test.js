import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_READ_ALOUD_CHARACTERS, readAloudText } from '../src/core/read-aloud.js';

test('read-aloud selection is page-aware, text-only, and bounded', () => {
  assert.equal(readAloudText([{ page: 2, text: '  Local speech  ' }], 2), 'Local speech');
  assert.equal(readAloudText([{ page: 1, text: 'x'.repeat(MAX_READ_ALOUD_CHARACTERS + 1) }], 1).length, MAX_READ_ALOUD_CHARACTERS);
  assert.equal(readAloudText([{ page: 1, text: ' ' }], 1), null);
  assert.equal(readAloudText([], 1), null);
});
