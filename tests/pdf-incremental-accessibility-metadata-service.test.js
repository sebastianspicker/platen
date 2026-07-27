import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfIncrementalAccessibilityMetadataService } from '../scripts/host/pdf-incremental-accessibility-metadata-service.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(24).fill(0)]);

test('accessibility metadata service binds raw /Lang and Info title proof to a passive append-only artifact', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-accessibility-metadata-')); context.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = makeTextPdf('Passive accessibility metadata source'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 }); const sha256 = createHash('sha256').update(sourceBytes).digest('hex'); let promoted;
  const store = {
    getDocument: () => ({ id: '11111111-1111-4111-8111-111111111111', sha256, size: sourceBytes.length, displayName: 'source.pdf', mediaType: 'application/pdf' }), getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sha256), createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; }, cleanupJob: (path) => rm(path, { recursive: true, force: true }),
    promotePdfArtifact: async (_id, path, options) => { const bytes = await readFile(path); assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256); promoted = { bytes, options }; return { id: 'artifact', sha256: options.expectedSha256 }; }, deleteArtifact: async () => {},
  };
  const poppler = { async execute(operation, parameters) {
    const output = parameters.input.endsWith('output.pdf');
    if (operation === 'inspect') return { stdout: `Title: ${output ? 'Accessible title' : ''}\nPages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\n`, stderr: '' };
    if (operation === 'inspectMetadata') return { stdout: '', stderr: '' }; if (operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' }; if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' }; if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' }; if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '' }; if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: '' }; if (operation === 'extractText') return { stdout: 'Passive accessibility metadata source\f', stderr: '' }; if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, png, { mode: 0o600 }); return { stdout: '', stderr: '' }; } assert.fail(operation);
  } };
  const result = await new PdfIncrementalAccessibilityMetadataService({ store, poppler }).update('11111111-1111-4111-8111-111111111111', { language: 'en-US', title: 'Accessible title' }, { sourceSha256: sha256 });
  assert.equal(result.metadata.profile, 'local-incremental-document-language-title-v1'); assert.equal(result.evidence.rawLanguageAndTitleMatched, true); assert(promoted.bytes.subarray(0, sourceBytes.length).equals(sourceBytes)); assert.equal(promoted.options.operation.parameters.profile, result.metadata.profile); assert.equal(result.metadata.requestSha256, createHash('sha256').update(JSON.stringify({ language: 'en-us', title: 'Accessible title' })).digest('hex')); assert.equal(promoted.options.operation.parameters.requestSha256, result.metadata.requestSha256); assert.match(promoted.bytes.toString('latin1'), /\/Lang <FEFF0065006E002D00750073>/);
});
