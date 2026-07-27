import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfAccessibilityLinksBookmarksService } from '../scripts/host/pdf-accessibility-links-bookmarks-service.mjs';
import { inspectPdfAccessibilityLinksBookmarksSource, inspectPdfAccessibilityLinksBookmarks, writePdfAccessibilityLinksBookmarks } from '../scripts/host/pdf-accessibility-links-bookmarks-writer.mjs';
import { normalizePdfAccessibilityLinksBookmarks } from '../scripts/host/pdf-accessibility-links-bookmarks-contract.mjs';

function sourcePdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>', '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Annots [6 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>',
    '<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>', '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [4 0 R /Fit] >>',
    '<< /Type /Outlines /Parent 5 0 R /Title (Go) /Dest [3 0 R /Fit] >>',
  ];
  const chunks = ['%PDF-1.4\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 8\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}

async function fixture(context, mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'links-bookmarks-service-')); context.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = sourcePdf(); const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const id = '11111111-1111-4111-8111-111111111111'; const artifactId = '22222222-2222-4222-8222-222222222222'; const deleted = []; let workspaces = 0;
  const store = {
    getDocument: () => ({ id, sha256: sourceSha256, size: sourceBytes.length, displayName: 'source.pdf' }), getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256),
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, `job-${workspaces++}-`)); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => rm(path, { recursive: true, force: true }), deleteArtifact: async (artifact) => deleted.push(artifact),
    promotePdfArtifact: async (_documentId, _path, options) => { if (mode === 'drift') await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n')]), { mode: 0o600 }); if (mode === 'cancel') context.controller.abort(new Error('cancelled')); const output = await readFile(_path); return mode === 'forged' ? { id: artifactId, documentId: 'wrong', mediaType: 'application/pdf', size: output.length, sha256: options.expectedSha256, displayName: 'source-links-bookmarks.pdf', operation: options.operation } : { id: artifactId, documentId: id, mediaType: 'application/pdf', size: output.length, sha256: options.expectedSha256, displayName: 'source-links-bookmarks.pdf', operation: options.operation }; },
  };
  const inventory = inspectPdfAccessibilityLinksBookmarksSource(sourceBytes, sourceSha256); const request = { profile: 'local-classic-incremental-links-bookmarks-v1', sourceSha256, links: [{ locator: { fingerprint: inventory.links[0].fingerprint }, purpose: 'Navigate', targetPage: 1 }], bookmarks: [{ locator: { fingerprint: inventory.bookmarks[0].fingerprint }, title: 'Overview', targetPage: 2 }] };
  const controller = new AbortController(); context.controller = controller; return { store, request, sourceSha256, service: new PdfAccessibilityLinksBookmarksService({ store }), deleted, controller };
}

test('service revokes a promoted artifact after cancellation and rejects forged promotion identity', async (context) => {
  const cancelled = await fixture(context, 'cancel'); await assert.rejects(cancelled.service.update('11111111-1111-4111-8111-111111111111', cancelled.request, { sourceSha256: cancelled.sourceSha256, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED' }); assert.deepEqual(cancelled.deleted, ['22222222-2222-4222-8222-222222222222']);
  const forged = await fixture(context, 'forged'); await assert.rejects(forged.service.update('11111111-1111-4111-8111-111111111111', forged.request, { sourceSha256: forged.sourceSha256 }), { code: 'ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID' }); assert.deepEqual(forged.deleted, []);
});

test('service revokes a valid promotion when source drifts during promotion', async (context) => {
  const drift = await fixture(context, 'drift'); await assert.rejects(drift.service.update('11111111-1111-4111-8111-111111111111', drift.request, { sourceSha256: drift.sourceSha256 }), { code: 'ACCESSIBILITY_LINKS_BOOKMARKS_FAILED' }); assert.deepEqual(drift.deleted, ['22222222-2222-4222-8222-222222222222']);
});

test('service rejects a proxied injectable raw result before reading its fields', async (context) => {
  const setup = await fixture(context); const core = {
    normalizePdfAccessibilityLinksBookmarks,
    writePdfAccessibilityLinksBookmarks: (...args) => new Proxy(writePdfAccessibilityLinksBookmarks(...args), { ownKeys() { throw new Error('trap'); } }),
    inspectPdfAccessibilityLinksBookmarks: inspectPdfAccessibilityLinksBookmarks,
  };
  const service = new PdfAccessibilityLinksBookmarksService({ store: setup.store, core });
  await assert.rejects(service.update('11111111-1111-4111-8111-111111111111', setup.request, { sourceSha256: setup.sourceSha256 }), { code: 'ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID' });
  assert.deepEqual(setup.deleted, []);
});
