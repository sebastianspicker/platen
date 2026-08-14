/**
 * Strict browser clipboard image admission shared by image-to-PDF and OCR
 * workflows.  Clipboard content is accepted only when it is one item with one
 * PNG representation and a bounded non-empty Blob.
 */
export const MAX_CLIPBOARD_PNG_BYTES = 32 * 1024 * 1024;

function clipboardTypes(item) {
  return Array.from(item?.types ?? []).filter((type) => typeof type === 'string');
}

export function assertSingleClipboardPngItem(items, label = 'Clipboard image') {
  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error(`${label} requires exactly one clipboard item.`);
  }
  const [item] = items;
  const types = clipboardTypes(item);
  if (types.length !== 1 || types[0] !== 'image/png') {
    throw new Error(`${label} requires exactly one PNG representation.`);
  }
  if (!item || typeof item.getType !== 'function') {
    throw new Error(`${label} cannot read the PNG representation.`);
  }
  return item;
}

export function assertClipboardPngBlob(blob, {
  label = 'Clipboard image',
  BlobCtor = globalThis.Blob,
} = {}) {
  if (typeof BlobCtor !== 'function' || !(blob instanceof BlobCtor)
    || blob.type !== 'image/png' || blob.size < 1) {
    throw new Error('The clipboard item is not a non-empty PNG image.');
  }
  if (blob.size > MAX_CLIPBOARD_PNG_BYTES) {
    throw new Error(`${label} exceeds the 32 MiB bound.`);
  }
  return blob;
}
