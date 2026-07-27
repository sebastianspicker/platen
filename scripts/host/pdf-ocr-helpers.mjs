import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { MAX_OCR_ALTO_BYTES } from './pdf-service-limits.mjs';
import { decodeUtf8 } from './pdf-output-guards.mjs';

export function parseTesseractLanguages(output) {
  return Object.freeze(String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9_]+$/.test(line))
    .sort());
}

export function parseTesseractTsv(output, page) {
  const lines = String(output ?? '').split(/\r?\n/);
  if (!lines.length) return Object.freeze([]);
  const headers = lines[0].split('\t');
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const words = [];
  for (const line of lines.slice(1)) {
    const columns = line.split('\t');
    const text = columns[index.text]?.trim();
    const confidence = Number.parseFloat(columns[index.conf]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    words.push(Object.freeze({
      page,
      text,
      confidence,
      left: Number.parseInt(columns[index.left], 10) || 0,
      top: Number.parseInt(columns[index.top], 10) || 0,
      width: Number.parseInt(columns[index.width], 10) || 0,
      height: Number.parseInt(columns[index.height], 10) || 0,
    }));
  }
  return Object.freeze(words);
}

export function validateOcrMode(cleanupPreset, segmentation) {
  if (!['none', 'document', 'bilevel'].includes(cleanupPreset)) throw new HostError('INVALID_OCR_CLEANUP', 'cleanupPreset must be none, document, or bilevel.', 400);
  if (!['auto', 'single-column', 'block', 'sparse'].includes(segmentation)) throw new HostError('INVALID_OCR_SEGMENTATION', 'Choose a supported local OCR segmentation mode.', 400);
}

export function ocrDpi(raster, pageGeometry) {
  const xDpi = raster.width * 72 / pageGeometry.widthPoints; const yDpi = raster.height * 72 / pageGeometry.heightPoints;
  const value = Math.round((xDpi + yDpi) / 2);
  if (!Number.isSafeInteger(value) || value < 72 || value > 600 || Math.abs(xDpi - yDpi) > 3) throw new HostError('INVALID_ENGINE_OUTPUT', 'OCR raster density does not match the PDF page geometry.', 502);
  return value;
}

export function strictOcrZone(zone, selectedPages) {
  if (!zone || typeof zone !== 'object' || Array.isArray(zone) || Object.keys(zone).sort().join(',') !== 'height,id,page,type,width,x,y'
    || typeof zone.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(zone.id)
    || !['text', 'table', 'image', 'exclude'].includes(zone.type)
    || !Number.isSafeInteger(zone.page) || !selectedPages.has(zone.page)
    || ![zone.x, zone.y, zone.width, zone.height].every(Number.isFinite)
    || zone.x < 0 || zone.y < 0 || zone.width <= 0 || zone.height <= 0
    || zone.x + zone.width > 1 || zone.y + zone.height > 1) {
    throw new HostError('INVALID_OCR_ZONES', 'Each OCR zone must be a strict named normalized rectangle on a selected page.', 400);
  }
  return Object.freeze({ id: zone.id, type: zone.type, page: zone.page, x: zone.x, y: zone.y, width: zone.width, height: zone.height });
}

export function ocrZonesOverlap(left, right) {
  return left.page === right.page
    && left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

export function cleanupReceipt(page, before, after, cleanupPreset) {
  return Object.freeze({
    page,
    preset: cleanupPreset,
    applied: cleanupPreset !== 'none',
    canvasPreserved: before.width === after.width && before.height === after.height,
    pre: Object.freeze({ sha256: before.sha256, width: before.width, height: before.height }),
    post: Object.freeze({ sha256: after.sha256, width: after.width, height: after.height }),
  });
}

export function cropDimensions(raster, zone) {
  return Object.freeze({ width: Math.max(1, Math.round(raster.width * zone.width)), height: Math.max(1, Math.round(raster.height * zone.height)) });
}

export function validateAltoEvidence(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OCR_ALTO_BYTES) {
    throw new HostError('INVALID_ENGINE_OUTPUT', 'Tesseract ALTO output is missing or exceeds the local limit.', 502);
  }
  const xml = decodeUtf8(bytes, 'OCR ALTO XML').trim();
  if (xml.includes('\0') || /<!DOCTYPE|<!ENTITY|\bSYSTEM\b|\bPUBLIC\b|<\?xml-stylesheet|<xi:include/iu.test(xml)) {
    throw new HostError('INVALID_ENGINE_OUTPUT', 'Tesseract ALTO output contains unsupported active XML constructs.', 502);
  }
  const withoutDeclaration = xml.replace(/^<\?xml\s+version=["']1\.[01]["'][^?]{0,256}\?>\s*/u, '');
  if (!/^<alto(?:\s[^<>]{0,2048})?>[\s\S]*<Layout(?:\s[^<>]{0,1024})?>[\s\S]*<Page(?:\s[^<>]{0,2048})?[\s\S]*<\/alto>$/u.test(withoutDeclaration)) {
    throw new HostError('INVALID_ENGINE_OUTPUT', 'Tesseract ALTO output has an invalid document envelope.', 502);
  }
  return Object.freeze({
    mediaType: 'application/alto+xml',
    encoding: 'base64',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  });
}

