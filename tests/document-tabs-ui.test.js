import assert from 'node:assert/strict';
import test from 'node:test';
import { documentTabsView } from '../src/ui/document-tabs-view.js';

test('document tab UI escapes names and exposes keyboard tab semantics', () => {
  const html = documentTabsView({
    documentTabs: {
      activeTabId: 'safe-id',
      tabs: [{ id: 'safe-id', name: '<unsafe & local>.pdf', status: 'ready' }],
    },
  });
  assert.match(html, /role="tablist"/u);
  assert.match(html, /role="tab"/u);
  assert.match(html, /aria-selected="true"/u);
  assert.match(html, /Close &lt;unsafe &amp; local&gt;\.pdf/u);
  assert.doesNotMatch(html, /<unsafe/u);
});

test('empty and loading/error states are announced without unsafe markup', () => {
  assert.match(documentTabsView({ documentTabs: { tabs: [], activeTabId: null } }), /No local documents open/u);
  const html = documentTabsView({ documentTabs: {
    activeTabId: 'id', tabs: [{ id: 'id', name: 'report.pdf', status: 'loading' }],
  } });
  assert.match(html, /report\.pdf \(loading\)/u);
});

