import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  inspectPdfAccessibilityLinksBookmarksSource,
  inspectPdfAccessibilityLinksBookmarks,
  writePdfAccessibilityLinksBookmarks,
} from '../scripts/host/pdf-accessibility-links-bookmarks-writer.mjs';
import { normalizePdfAccessibilityLinksBookmarks } from '../scripts/host/pdf-accessibility-links-bookmarks-contract.mjs';

function fixture({ external = false, cycle = false, nested = false } = {}) {
  const linkDestination = external ? '/A << /S /URI /URI (https://example.test) >>' : '/Dest [4 0 R /Fit]';
  const outlineNext = cycle ? '/Next 7 0 R' : '';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Annots [6 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>',
    `<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count ${nested ? 2 : 1} >>`,
    `<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] ${linkDestination} >>`,
    `<< /Type /Outlines /Parent 5 0 R /Title (Go) /Dest [3 0 R /Fit] ${nested ? '/First 8 0 R /Last 8 0 R /Count 1' : outlineNext} >>`,
    ...(nested ? ['<< /Type /Outlines /Parent 7 0 R /Title (Child) /Dest [4 0 R /Fit] >>'] : []),
  ];
  const chunks = ['%PDF-1.4\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function request(source, inventory, overrides = {}) {
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  return {
    profile: 'local-classic-incremental-links-bookmarks-v1', sourceSha256: overrides.sourceSha256 ?? sourceSha256,
    links: [{ locator: { fingerprint: inventory.links[0].fingerprint }, purpose: 'Go to appendix', targetPage: overrides.linkPage ?? 1 }],
    bookmarks: [{ locator: { fingerprint: inventory.bookmarks[0].fingerprint }, title: 'Overview', targetPage: overrides.bookmarkPage ?? 2 }],
  };
}

test('links/bookmarks repair preserves source prefix and can move both destinations', () => {
  const source = fixture(); const sha256 = createHash('sha256').update(source).digest('hex');
  const inventory = inspectPdfAccessibilityLinksBookmarksSource(source, sha256); const value = request(source, inventory);
  const result = writePdfAccessibilityLinksBookmarks(source, value);
  assert(result.bytes.subarray(0, source.length).equals(source));
  assert.equal(result.proof.links[0].targetPage, 1); assert.equal(result.proof.bookmarks[0].targetPage, 2);
  assert.deepEqual(inspectPdfAccessibilityLinksBookmarks(source, result.bytes, value), result.proof);
});

test('links/bookmarks reject stale source digests, forged locators, proxies, URI actions, and outline cycles', () => {
  const source = fixture(); const sha256 = createHash('sha256').update(source).digest('hex'); const inventory = inspectPdfAccessibilityLinksBookmarksSource(source, sha256);
  assert.throws(() => writePdfAccessibilityLinksBookmarks(source, request(source, inventory, { linkPage: 2, bookmarkPage: 1, sourceSha256: '0'.repeat(64) })), { code: 'UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF' });
  const forged = request(source, inventory); forged.links[0].locator.fingerprint = '0'.repeat(64);
  assert.throws(() => writePdfAccessibilityLinksBookmarks(source, forged), { code: 'UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF' });
  const proxy = new Proxy(request(source, inventory), { ownKeys() { throw new Error('proxy'); } });
  assert.throws(() => writePdfAccessibilityLinksBookmarks(source, proxy), { code: 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS' });
  const uri = fixture({ external: true }); assert.throws(() => inspectPdfAccessibilityLinksBookmarksSource(uri, createHash('sha256').update(uri).digest('hex')), { code: 'UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF' });
  const cyclic = fixture({ cycle: true }); assert.throws(() => inspectPdfAccessibilityLinksBookmarksSource(cyclic, createHash('sha256').update(cyclic).digest('hex')), { code: 'UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF' });
  const surrogate = request(source, inventory); surrogate.links[0].purpose = '\ud800'; assert.throws(() => writePdfAccessibilityLinksBookmarks(source, surrogate), { code: 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS' });
});

test('links/bookmarks share the 64-target repair limit', () => {
  const hash = (index) => index.toString(16).padStart(64, '0');
  assert.throws(() => normalizePdfAccessibilityLinksBookmarks({
    profile: 'local-classic-incremental-links-bookmarks-v1', sourceSha256: hash(0),
    links: Array.from({ length: 64 }, (_, index) => ({ locator: { fingerprint: hash(index + 1) }, purpose: 'Purpose', targetPage: 1 })),
    bookmarks: [{ locator: { fingerprint: hash(65) }, title: 'Bookmark', targetPage: 1 }],
  }), { code: 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS' });
});

test('nested bookmark inventories use numeric paths for strict client transport', () => {
  const inventory = inspectPdfAccessibilityLinksBookmarksSource(fixture({ nested: true }));
  assert.deepEqual(inventory.bookmarks.map(({ path }) => path), [[0], [0, 0]]);
});
