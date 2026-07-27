import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { PdfJpegImageReplacementService } from '../scripts/host/pdf-jpeg-image-replacement-service.mjs';
import { PDF_JPEG_IMAGE_REPLACEMENT_PROFILE } from '../scripts/host/pdf-jpeg-image-replacement-writer.mjs';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==', 'base64');
const documentId = '123e4567-e89b-12d3-a456-426614174000';

function fixture() {
  const content = 'q 80 0 0 60 10 20 cm /Im0 Do Q\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${JPEG.length} >>\nstream\n${JPEG.toString('latin1')}\nendstream`,
  ];
  const chunks = ['%PDF-1.4\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

test('replacement service validates promotion through the installed Poppler adapter toolchain', async (context) => {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 16 });
  const registry = new EngineRegistry({ runner });
  const required = ['pdfinfo', 'pdftotext', 'pdfimages', 'pdftocairo'];
  const probes = await Promise.allSettled(required.map((name) => registry.probe(name)));
  if (probes.some(({ status }) => status === 'rejected')) { context.skip('Required Poppler adapters are unavailable.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'jpeg-replacement-installed-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = fixture(); const replacement = Buffer.from(JPEG); replacement[replacement.length - 3] ^= 1;
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex'); const poppler = new PopplerAdapter({ registry, runner });
  const store = {
    getDocument: () => ({ id: documentId, size: sourceBytes.length, sha256: sourceSha256 }),
    getSourcePath: () => sourcePath,
    verifySource: async () => { assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256); },
    createJobWorkspace: async () => mkdtemp(join(root, 'job-')),
    cleanupJob: async (path) => rm(path, { recursive: true, force: true }),
    promotePdfArtifact: async (_id, path, options) => {
      const bytes = await readFile(path); const sha256 = createHash('sha256').update(bytes).digest('hex'); assert.equal(sha256, options.expectedSha256);
      return { id: '223e4567-e89b-12d3-a456-426614174000', documentId, displayName: options.displayName, mediaType: 'application/pdf', size: bytes.length, sha256, operation: options.operation, createdAt: new Date(0).toISOString() };
    },
    deleteArtifact: async () => {},
  };
  const service = new PdfJpegImageReplacementService({ store, poppler });
  const result = await service.replace(documentId, { profile: PDF_JPEG_IMAGE_REPLACEMENT_PROFILE, sourceSha256, page: 1, resourceName: 'Im0', jpegBytes: replacement }, { sourceSha256 });
  assert.deepEqual(result.evidence, { sourcePrefixPreserved: true, contentPreserved: true, resourceIdentityPreserved: true, objectIdentityPreserved: true, outputDigestBound: true, sourceUnchanged: true, localOnly: true });
  assert.deepEqual(result.artifact.operation.validation.validators, ['source-sha256', 'private-source-copy', 'raw-jpeg-image-replacement-proof', 'artifact-sha256', 'pdfinfo-page-count', 'pdfinfo-page-boxes', 'pdftotext-equality', 'pdfimages-target-identity', 'pdftocairo-render-change', 'pdftocairo-target-region']);
  const info = await poppler.execute('inspect', { input: sourcePath }); assert.match(info.stdout, /Pages:\s+1/u);
  const images = await poppler.execute('listImages', { input: sourcePath }); assert.match(images.stdout, /jpeg/u);
});
