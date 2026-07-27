import { basename, extname } from 'node:path';
import { HostError } from './host-error.mjs';

const MAX_INLINE_HTML_BYTES = 8 * 1024 * 1024;

export function assertInlineOnlyHtml(buffer) {
  if (buffer.length > MAX_INLINE_HTML_BYTES) {
    throw new HostError(
      'HTML_TOO_LARGE',
      `Local HTML conversion is limited to ${MAX_INLINE_HTML_BYTES} bytes.`,
      413,
    );
  }
  const html = buffer.toString('utf8');
  const active = /<(?:script|iframe|object|embed|link)\b|\bon\w+\s*=|@import\b|\b(?:src|href)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)|url\s*\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  if (active.test(html)) {
    throw new HostError(
      'HTML_EXTERNAL_CONTENT_FORBIDDEN',
      'HTML conversion accepts inline, passive markup only; scripts, handlers, embeds, and external resources are forbidden.',
      422,
    );
  }
}

export function cleanConversionStem(displayName) {
  return basename(displayName, extname(displayName))
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 120) || 'converted';
}

export function canUseTextFallback(asset, error, signal) {
  if (!['office', 'text', 'html'].includes(asset.kind) || signal?.aborted) return false;
  return ![
    'ENGINE_TIMEOUT', 'ENGINE_CANCELLED', 'ENGINE_QUEUE_FULL', 'ENGINE_HOST_UNHEALTHY',
  ].includes(error?.code);
}
