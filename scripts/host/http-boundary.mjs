import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { securityHeaders } from '../server-lib.mjs';
import { HostError } from './host-error.mjs';

const JSON_BODY_LIMIT = 32 * 1024;
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SNAPSHOT_QUERY_KEYS = Object.freeze(['page', 'dpi', 'x', 'y', 'width', 'height']);

export function write(response, status, body, contentType, extraHeaders = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    ...extraHeaders,
  });
  response.end(buffer);
}

export function json(response, status, value) {
  write(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

export function empty(response, status = 204) {
  response.writeHead(status, { ...securityHeaders(), 'Content-Length': '0' });
  response.end();
}

export function method(request, expected) {
  if (request.method !== expected) {
    throw new HostError('METHOD_NOT_ALLOWED', `This endpoint requires ${expected}.`, 405);
  }
}

export function hasToken(request, token) {
  const candidate = request.headers['x-platen-token'];
  if (typeof candidate !== 'string') return false;
  const expectedBytes = Buffer.from(token);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}

export function requireSameOrigin(request) {
  if (!mutationMethods.has(request.method ?? '')) return;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') {
    throw new HostError('ORIGIN_REQUIRED', 'State-changing local requests require a same-origin browser origin.', 403);
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HostError('ORIGIN_FORBIDDEN', 'The request origin is not allowed.', 403);
  }
  if (parsed.protocol !== 'http:' || parsed.host !== host || parsed.pathname !== '/') {
    throw new HostError('ORIGIN_FORBIDDEN', 'The request origin is not allowed.', 403);
  }
}

export function requireLocalFetchMetadata(request) {
  const site = request.headers['sec-fetch-site'];
  const mode = request.headers['sec-fetch-mode'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    throw new HostError('FETCH_CONTEXT_FORBIDDEN', 'Cross-site bootstrap requests are not allowed.', 403);
  }
  if (mode === 'no-cors') {
    throw new HostError('FETCH_CONTEXT_FORBIDDEN', 'Opaque bootstrap requests are not allowed.', 403);
  }
}

export function requireContentType(request, expected) {
  const actual = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (actual !== expected) {
    throw new HostError('UNSUPPORTED_MEDIA_TYPE', `This endpoint requires ${expected}.`, 415);
  }
}

export async function readJson(request, maximumBytes = JSON_BODY_LIMIT) {
  requireContentType(request, 'application/json');
  const chunks = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maximumBytes) throw new HostError('BODY_TOO_LARGE', 'The JSON request body is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HostError('INVALID_JSON', 'The request body is not valid JSON.', 400);
  }
}

export async function readBytes(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maximumBytes) throw new HostError('BODY_TOO_LARGE', 'The request body is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function decodeDisplayName(request) {
  const encoded = request.headers['x-document-name'];
  if (typeof encoded !== 'string' || !encoded) return 'local-document.pdf';
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new HostError('INVALID_DOCUMENT_NAME', 'The encoded document name is invalid.', 400);
  }
}

export function parsePositiveInteger(value, label, { minimum = 1, maximum = 1_000_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== String(value) || parsed < minimum || parsed > maximum) {
    throw new HostError('INVALID_PARAMETER', `${label} must be an integer from ${minimum} through ${maximum}.`, 400);
  }
  return parsed;
}

export function parseSnapshotRegion(searchParams) {
  if (searchParams.size !== SNAPSHOT_QUERY_KEYS.length
    || SNAPSHOT_QUERY_KEYS.some((key) => !searchParams.has(key))) {
    throw new HostError('INVALID_PARAMETER', 'CropBox snapshot rendering requires only page, dpi, x, y, width, and height.', 400);
  }
  const decimal = (label) => {
    const value = searchParams.get(label);
    if (typeof value !== 'string' || !/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value)) {
      throw new HostError('INVALID_PARAMETER', `${label} must be a normalized decimal with at most six decimal places.`, 400);
    }
    return Number(value);
  };
  const region = { x: decimal('x'), y: decimal('y'), width: decimal('width'), height: decimal('height') };
  if (region.x >= 1 || region.y >= 1 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new HostError('INVALID_PARAMETER', 'Snapshot region must be a positive rectangle inside the normalized page raster.', 400);
  }
  return Object.freeze(region);
}

function downloadHeaders(fileName) {
  const ascii = String(fileName).replace(/[^a-zA-Z0-9._ -]/g, '_').replaceAll('"', '').slice(0, 160) || 'document.pdf';
  return {
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  };
}

export function sendArtifact(response, artifact, { onSettled = null } = {}) {
  let settled = false;
  const settle = () => {
    if (settled || typeof onSettled !== 'function') return;
    settled = true;
    Promise.resolve(onSettled()).catch(() => {});
  };
  if (onSettled) {
    response.once('finish', settle);
    response.once('close', settle);
  }
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': artifact.mediaType,
    'Content-Length': artifact.size,
    ...downloadHeaders(artifact.displayName),
  });
  const stream = createReadStream(artifact.filePath);
  if (onSettled) stream.once('close', settle);
  stream.on('error', () => {
    response.destroy();
    settle();
  }).pipe(response);
}

export function sendPortableProject(response, bundle) {
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': bundle.mediaType,
    'Content-Length': bundle.size,
    ...downloadHeaders(bundle.displayName),
  });
  response.write(bundle.prefix);
  createReadStream(bundle.sourcePath).on('error', () => response.destroy()).pipe(response);
}
