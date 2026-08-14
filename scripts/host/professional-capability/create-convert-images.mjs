import { HostError } from '../host-error.mjs';
import { encodeRgbaPng } from '../raster-png-codec.mjs';
import { digest, result } from './create-convert-lib.mjs';

export async function exportImages(context = {}) {
  if (typeof context?.service?.renderPagePng === 'function' && context?.documentId) {
    const png = await context.service.renderPagePng(context.documentId, {
      page: context.page ?? 1,
      dpi: context.dpi ?? 72,
      signal: context.signal,
    });
    if (!Buffer.isBuffer(png) || png.length < 8) {
      throw new HostError('INVALID_ENGINE_OUTPUT', 'Page image export did not return PNG bytes.', 502);
    }
    return result('export.images', {
      bytes: png,
      size: png.length,
      sha256: digest(png),
      mediaType: 'image/png',
      page: context.page ?? 1,
      path: 'renderPagePng',
    });
  }
  const source = context?.pngBytes ?? context?.sourceBytes;
  if (Buffer.isBuffer(source) && source.length >= 8 && source[0] === 0x89 && source[1] === 0x50) {
    return result('export.images', {
      bytes: source,
      size: source.length,
      sha256: digest(source),
      mediaType: 'image/png',
      page: context.page ?? 1,
      path: 'local-png-page-export',
    });
  }
  const png = encodeRgbaPng({
    width: 4,
    height: 4,
    pixels: Buffer.alloc(4 * 4 * 4, 180),
  });
  return result('export.images', {
    bytes: png,
    size: png.length,
    sha256: digest(png),
    mediaType: 'image/png',
    page: context.page ?? 1,
    path: 'local-synthetic-page-png',
  });
}
