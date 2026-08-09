import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { createComparisonEndpoints } from '../src/core/local-host-comparison-endpoints.js';

const primary = '11111111-1111-4111-8111-111111111111';
const secondary = '22222222-2222-4222-8222-222222222222';
const leftSha = 'a'.repeat(64);
const rightSha = 'b'.repeat(64);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function inputs() {
  return [
    { documentId: primary, sha256: leftSha, role: 'primary' },
    { documentId: secondary, sha256: rightSha, role: 'secondary' },
  ];
}
function content() {
  return {
    kind: 'content', inputs: inputs(),
    stats: { added: 1, deleted: 0, unchanged: 1, changed: 1, leftPages: 1, rightPages: 1 },
    pages: [{ page: 1, leftPresent: true, rightPresent: true, runs: [{ kind: 'added', text: 'new', count: 1 }, { kind: 'unchanged', text: 'same', count: 1 }], stats: { added: 1, deleted: 0, unchanged: 1 } }],
  };
}
function pixel() {
  const png = encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([255, 0, 0, 255]) });
  const data = png.toString('base64');
  return {
    kind: 'pixel', inputs: inputs(), dpi: 96,
    stats: { comparedPages: 1, changedPixels: 1, comparedPixels: 1 },
    pages: [{ page: 1, status: 'compared', width: 1, height: 1, left: { width: 1, height: 1 }, right: { width: 1, height: 1 }, changedPixels: 1, comparedPixels: 1, dimensionMismatch: false, meanChannelDelta: 1, maximumChannelDelta: 1, differenceImage: { format: 'image/png', encoding: 'base64', sha256: createHash('sha256').update(png).digest('hex'), data } }],
  };
}
function overlay() {
  const png = encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([255, 0, 0, 255]) });
  const sha256 = createHash('sha256').update(png).digest('hex');
  return {
    kind: 'overlay', inputs: inputs(), page: 1, dpi: 72, opacity: 0.5,
    semantics: 'primary-red-secondary-cyan',
    image: { mediaType: 'image/png', encoding: 'base64', sha256, size: png.length, data: png.toString('base64') },
    validation: { decoded: true, width: 1, height: 1, outputSha256: sha256, sourceReread: true },
  };
}
function sideBySide() {
  const panes = [[
    'primary', encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
  ], [
    'secondary', encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([255, 0, 0, 255]) }),
  ]].map(([role, png]) => ({
    role, mediaType: 'image/png', encoding: 'base64',
    sha256: createHash('sha256').update(png).digest('hex'), size: png.length,
    width: 1, height: 1, data: png.toString('base64'),
  }));
  return {
    kind: 'side-by-side', inputs: inputs(), page: 1, dpi: 72,
    semantics: 'primary-left-secondary-right', panes,
    validation: { sourceReread: true },
  };
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, bytes) {
  const chunk = Buffer.alloc(bytes.length + 12); chunk.writeUInt32BE(bytes.length, 0); chunk.write(type, 4, 4, 'ascii'); bytes.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, bytes.length + 8)), bytes.length + 8); return chunk;
}
function forgedOverlayPng(idat, ancillaryType = null) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header.set([8, 6, 0, 0, 0], 8);
  const ancillary = ancillaryType ? [pngChunk(ancillaryType, Buffer.alloc(0))] : [];
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), ...ancillary, pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function withOverlayImage(report, png) {
  report.image.data = png.toString('base64'); report.image.size = png.length;
  report.image.sha256 = createHash('sha256').update(png).digest('hex'); report.validation.outputSha256 = report.image.sha256;
  return report;
}
function padBitAlias(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const padding = value.endsWith('==') ? 2 : 1;
  const position = value.length - padding - 1; const index = alphabet.indexOf(value[position]);
  return `${value.slice(0, position)}${alphabet[index | (padding === 2 ? 16 : 4)]}${value.slice(position + 1)}`;
}
function transport(report, calls = []) {
  return createComparisonEndpoints({ json: async (path, options) => { calls.push({ path, options }); return { report }; } });
}

test('comparison client sends bounded requests and returns deeply frozen snapshots', async () => {
  const calls = []; const endpoint = transport(content(), calls);
  const report = await endpoint.compareDocuments(primary, secondary, 'content');
  assert.equal(report.kind, 'content'); assert.equal(Object.isFrozen(report), true); assert.equal(Object.isFrozen(report.inputs), true); assert.equal(Object.isFrozen(report.pages[0].runs), true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { secondaryDocumentId: secondary, mode: 'content', options: {} });

  const pixelEndpoint = transport(pixel(), calls);
  const pixelReport = await pixelEndpoint.compareDocuments(primary, secondary, 'pixel', { pages: [1], dpi: 96 });
  assert.equal(pixelReport.pages[0].differenceImage.format, 'image/png');
  const batch = await transport({ kind: 'batch', mode: 'content', reports: [content()] }).compareBatch([{ primaryDocumentId: primary, secondaryDocumentId: secondary }]);
  assert.equal(batch.reports[0].inputs[0].documentId, primary); assert.equal(Object.isFrozen(batch.reports), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), { secondaryDocumentId: secondary, mode: 'pixel', options: { pages: [1], dpi: 96 } });
  const rendered = await transport(overlay()).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 });
  assert.equal(rendered.image.mediaType, 'image/png'); assert.equal(rendered.validation.sourceReread, true);
  const panes = await transport(sideBySide()).compareDocuments(primary, secondary, 'side-by-side', { page: 1 });
  assert.deepEqual(panes.panes.map(({ role }) => role), ['primary', 'secondary']);
  assert.equal(panes.validation.sourceReread, true);
});

test('comparison client enforces exact mode, page, pair, and descriptor bounds', () => {
  const endpoint = transport(content());
  for (const call of [
    () => endpoint.compareDocuments('doc', secondary, 'content'),
    () => endpoint.compareDocuments(primary, primary, 'content'),
    () => endpoint.compareDocuments(primary, secondary, 'remote'),
    () => endpoint.compareDocuments(primary, secondary, 'content', { extra: true }),
    () => endpoint.compareDocuments(primary, secondary, 'pixel', { pages: [1, 1] }),
    () => endpoint.compareDocuments(primary, secondary, 'pixel', { pages: [201] }),
    () => endpoint.compareDocuments(primary, secondary, 'pixel', { dpi: 35 }),
    () => endpoint.compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 1 }),
    () => endpoint.compareDocuments(primary, secondary, 'side-by-side', { page: 0 }),
    () => endpoint.compareBatch([], 'content'),
    () => endpoint.compareBatch([{ primaryDocumentId: primary, secondaryDocumentId: secondary, extra: true }], 'content'),
    () => endpoint.compareBatch([{ primaryDocumentId: primary, secondaryDocumentId: secondary }], 'annotations'),
  ]) assert.throws(call, TypeError);
});

test('comparison client rejects forged, leaky, and hostile reports', async () => {
  const forged = content(); forged.inputs[0].documentId = secondary;
  await assert.rejects(transport(forged).compareDocuments(primary, secondary, 'content'), TypeError);
  const uppercase = content(); uppercase.inputs[0].sha256 = 'A'.repeat(64);
  await assert.rejects(transport(uppercase).compareDocuments(primary, secondary, 'content'), TypeError);
  const leaked = content(); leaked.secret = 'source bytes';
  await assert.rejects(transport(leaked).compareDocuments(primary, secondary, 'content'), TypeError);
  const hostile = new Proxy(content(), { ownKeys() { throw new Error('must not enumerate'); } });
  await assert.rejects(transport(hostile).compareDocuments(primary, secondary, 'content'), TypeError);
  const transparentProxy = new Proxy(content(), {});
  await assert.rejects(transport(transparentProxy).compareDocuments(primary, secondary, 'content'), TypeError);
  const accessor = content(); Object.defineProperty(accessor, 'kind', { enumerable: true, get() { throw new Error('must not read'); } });
  await assert.rejects(transport(accessor).compareDocuments(primary, secondary, 'content'), TypeError);
  const badPng = pixel(); badPng.pages[0].differenceImage.sha256 = '0'.repeat(64);
  await assert.rejects(transport(badPng).compareDocuments(primary, secondary, 'pixel', { dpi: 96 }), TypeError);
  const descriptor = { kind: 'overlay', status: 'descriptor-only', rendered: false, semantics: 'x', inputs: inputs(), page: 1, options: { opacity: 0.5 } };
  await assert.rejects(transport(descriptor).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const badOverlayDigest = overlay(); badOverlayDigest.image.sha256 = '0'.repeat(64);
  await assert.rejects(transport(badOverlayDigest).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const badOverlayPng = overlay(); const malformed = Buffer.from(badOverlayPng.image.data, 'base64'); malformed[12] = 0; badOverlayPng.image.data = malformed.toString('base64'); badOverlayPng.image.size = malformed.length; badOverlayPng.image.sha256 = createHash('sha256').update(malformed).digest('hex'); badOverlayPng.validation.outputSha256 = badOverlayPng.image.sha256;
  await assert.rejects(transport(badOverlayPng).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const wrongGeometry = overlay(); wrongGeometry.validation.width = 2;
  await assert.rejects(transport(wrongGeometry).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const wrongBinding = overlay(); wrongBinding.inputs.reverse();
  await assert.rejects(transport(wrongBinding).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const overlayExtra = overlay(); overlayExtra.image.extra = true;
  await assert.rejects(transport(overlayExtra).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const overlayAccessor = overlay(); Object.defineProperty(overlayAccessor.image, 'data', { enumerable: true, get() { throw new Error('must not read'); } });
  await assert.rejects(transport(overlayAccessor).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const overlayProxy = new Proxy(overlay(), { ownKeys() { throw new Error('must not enumerate'); } });
  await assert.rejects(transport(overlayProxy).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  const nonCanonical = overlay(); nonCanonical.image.data = padBitAlias(nonCanonical.image.data);
  await assert.rejects(transport(nonCanonical).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }), TypeError);
  await assert.rejects(
    transport(withOverlayImage(overlay(), forgedOverlayPng(Buffer.from([0xff])))).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }),
    TypeError,
  );
  await assert.rejects(
    transport(withOverlayImage(overlay(), forgedOverlayPng(deflateSync(Buffer.from([5, 0, 0, 0, 0]))))).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }),
    TypeError,
  );
  await assert.rejects(
    transport(withOverlayImage(overlay(), forgedOverlayPng(deflateSync(Buffer.from([0, 0, 0, 0, 0])), 'abct'))).compareDocuments(primary, secondary, 'overlay', { page: 1, opacity: 0.5 }),
    TypeError,
  );
  const swappedPanes = sideBySide(); swappedPanes.panes.reverse();
  await assert.rejects(transport(swappedPanes).compareDocuments(primary, secondary, 'side-by-side', { page: 1 }), TypeError);
  const paneDigest = sideBySide(); paneDigest.panes[0].sha256 = '0'.repeat(64);
  await assert.rejects(transport(paneDigest).compareDocuments(primary, secondary, 'side-by-side', { page: 1 }), TypeError);
  const paneGeometry = sideBySide(); paneGeometry.panes[1].width = 2;
  await assert.rejects(transport(paneGeometry).compareDocuments(primary, secondary, 'side-by-side', { page: 1 }), TypeError);
  const paneBase64 = sideBySide(); paneBase64.panes[0].data = padBitAlias(paneBase64.panes[0].data);
  await assert.rejects(transport(paneBase64).compareDocuments(primary, secondary, 'side-by-side', { page: 1 }), TypeError);
  const panePng = sideBySide(); panePng.panes[0].data = forgedOverlayPng(deflateSync(Buffer.from([5, 0, 0, 0, 0]))).toString('base64'); panePng.panes[0].size = Buffer.from(panePng.panes[0].data, 'base64').length; panePng.panes[0].sha256 = createHash('sha256').update(Buffer.from(panePng.panes[0].data, 'base64')).digest('hex');
  await assert.rejects(transport(panePng).compareDocuments(primary, secondary, 'side-by-side', { page: 1 }), TypeError);
});
