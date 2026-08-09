import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonResult } from '../src/ui/editor-result-review.js';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgH/LSA6SAAAAABJRU5ErkJggg==';

test('side-by-side comparison result renders two independently labeled PNG panes', () => {
  const html = comparisonResult({
    comparisonFileName: 'revision.pdf',
    comparisonReport: {
      kind: 'side-by-side', page: 3,
      panes: [
        { role: 'primary', mediaType: 'image/png', encoding: 'base64', data },
        { role: 'secondary', mediaType: 'image/png', encoding: 'base64', data },
      ],
    },
  });
  assert.match(html, /Two independent local page panes rendered for review\./u);
  assert.match(html, /Primary PDF · left pane · page 3/u);
  assert.match(html, /Secondary PDF · right pane · page 3/u);
  assert.equal((html.match(/data:image\/png;base64,/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /descriptor-only|Review layout descriptor/u);
});

test('side-by-side renderer omits malformed panes without interpolating hostile values', () => {
  const html = comparisonResult({
    comparisonReport: {
      kind: 'side-by-side', page: '<script>',
      panes: [{ role: 'primary', mediaType: 'image/png', encoding: 'base64', data: 'bad" onerror="alert(1)' }],
    },
  });
  assert.doesNotMatch(html, /data:image\/png|onerror|<script>/u);
});
