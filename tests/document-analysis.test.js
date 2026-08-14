import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { searchTextPages, structuredTextExport, textExport } from '../src/core/document-analysis.js';

test('document text search is case-insensitive, page-aware, bounded, and contextual', () => {
  const results = searchTextPages([
    { page: 1, text: 'Alpha local PDF alpha.' },
    { page: 2, text: 'No match.' },
  ], 'ALPHA', { limit: 1, context: 6 });
  assert.equal(results.length, 1);
  assert.equal(results[0].page, 1);
  assert.equal(results[0].match, 'Alpha');
  assert.equal(Object.isFrozen(results), true);
  assert.deepEqual(searchTextPages([], ''), []);
});

test('advanced text search supports bounded case-sensitive and whole-word matching', () => {
  const pages = [{ page: 1, text: 'Alpha alphabet alpha ALPHA' }];
  assert.deepEqual(
    searchTextPages(pages, 'Alpha', { caseSensitive: true }).map(({ match }) => match),
    ['Alpha'],
  );
  assert.deepEqual(
    searchTextPages(pages, 'alpha', { wholeWord: true }).map(({ match }) => match),
    ['Alpha', 'alpha', 'ALPHA'],
  );
  assert.equal(searchTextPages(pages, 'a', { limit: Number.POSITIVE_INFINITY }).length <= 200, true);
  assert.equal(Object.isFrozen(searchTextPages(pages, 'alpha')), true);
});

test('text export labels page boundaries without inventing content', () => {
  assert.equal(textExport([{ page: 1, text: 'One' }, { page: 2, text: 'Two\n' }]), '--- Page 1 ---\nOne\n\n--- Page 2 ---\nTwo');
});

test('structured local exports escape markup and produce bounded interoperable formats', () => {
  const pages = [{ page: 1, text: '<unsafe> & café {draft} \\path 😀' }];
  const text = structuredTextExport(pages, 'text');
  assert.equal(text.extension, 'txt');
  assert.match(text.data, /<unsafe> & café/);

  const rtf = structuredTextExport(pages, 'rtf');
  assert.equal(rtf.extension, 'rtf');
  assert.match(rtf.data, /\\u233\?/);
  assert.match(rtf.data, /\\\{draft\\\}/);
  assert.equal(rtf.data.includes('\\\\path'), true);
  assert.match(rtf.data, /\\u-10179\?\\u-8704\?/u);

  const html = structuredTextExport(pages, 'html', { title: 'A & B' });
  assert.equal(html.extension, 'html');
  assert.match(html.data, /<title>A &amp; B<\/title>/);
  assert.match(html.data, /&lt;unsafe&gt; &amp; café/);

  const xml = structuredTextExport(pages, 'xml', { title: 'A "quote"' });
  assert.equal(xml.extension, 'xml');
  assert.match(xml.data, /title="A &quot;quote&quot;"/);
  assert.throws(() => structuredTextExport(pages, 'docx'), /text, rtf, html, or xml/);
});

test('structured XML export preserves valid XML 1.0 text and astral characters', () => {
  const xml = structuredTextExport([
    { page: 1, text: 'tab\there\nline\rreturn 😀 & <safe>' },
  ], 'xml', { title: 'A "title" & 😀' });
  assert.match(xml.data, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/u);
  assert.match(xml.data, /title="A &quot;title&quot; &amp; 😀"/u);
  assert.match(xml.data, /tab\there\nline&#13;return 😀 &amp; &lt;safe&gt;/u);
});

test('structured XML export round-trips XML-normalized whitespace', (context) => {
  if (!existsSync('/usr/bin/xmllint')) {
    context.skip('xmllint is unavailable for XML parsed-value verification.');
    return;
  }
  const xml = structuredTextExport([
    { page: 1, text: 'A\rB\tC\nD' },
  ], 'xml', { title: 'T\tN\rR\nL' });
  assert.match(xml.data, /title="T&#9;N&#13;R&#10;L"/u);
  assert.match(xml.data, />A&#13;B\tC\nD<\/page>/u);
  const parsed = spawnSync('/usr/bin/xmllint', [
    '--xpath', 'concat(/document/@title,"|",/document/page/text())', '-',
  ], { input: xml.data, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, 'T\tN\rR\nL|A\rB\tC\nD\n');
});

test('structured XML export rejects every sampled XML 1.0-invalid character', () => {
  const invalidCharacters = ['\u0000', '\u000b', '\u000c', '\ud800', '\udc00', '\ufffe', '\uffff'];
  for (const character of invalidCharacters) {
    assert.throws(
      () => structuredTextExport([{ page: 1, text: `invalid${character}` }], 'xml'),
      /forbidden by XML 1\.0/u,
    );
    assert.throws(
      () => structuredTextExport([{ page: 1, text: 'valid' }], 'xml', { title: `invalid${character}` }),
      /forbidden by XML 1\.0/u,
    );
  }
});
