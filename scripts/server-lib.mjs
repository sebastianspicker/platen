import { createReadStream, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const publicFiles = new Set(['index.html']);
const publicDirectories = new Set(['catalog', 'src', 'styles']);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "object-src 'self' blob:",
  'frame-src blob:',
  "worker-src 'none'",
  "media-src 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': contentSecurityPolicy,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

export function isAllowedHost(value, host, port) {
  return value === `${host}:${port}` || value === `localhost:${port}`;
}

function containsSymlink(root, relativeParts) {
  let current = root;
  for (const part of relativeParts) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

export function resolvePublicFile(root, rawPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (!publicFiles.has(relative) && !publicDirectories.has(parts[0])) return null;

  const rootReal = realpathSync(root);
  const filePath = resolve(rootReal, ...parts);
  if (!filePath.startsWith(`${rootReal}${sep}`) || !existsSync(filePath)) return null;
  try {
    if (containsSymlink(rootReal, parts)) return null;
    const fileReal = realpathSync(filePath);
    if (!fileReal.startsWith(`${rootReal}${sep}`) || !statSync(fileReal).isFile()) return null;
    return fileReal;
  } catch {
    return null;
  }
}

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function createStaticHandler({ root, host, port }) {
  return (request, response) => {
    if (!isAllowedHost(request.headers.host, host, port)) {
      send(response, 421, 'Misdirected request.');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      send(response, 405, 'Method not allowed.');
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
    } catch {
      send(response, 400, 'Invalid request path.');
      return;
    }
    const filePath = resolvePublicFile(root, pathname);
    if (!filePath) {
      send(response, 404, 'Not found.');
      return;
    }

    const stat = statSync(filePath);
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream',
      'Content-Length': stat.size,
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  };
}
