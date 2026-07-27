import { basename, resolve, sep } from 'node:path';
import { HostError } from './host-error.mjs';

export const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/;
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');

export function cleanDisplayName(value, fallback = 'local-document.pdf') {
  const leaf = basename(String(value ?? '').replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return leaf || fallback;
}

export function containsPdfHeader(buffer) {
  return buffer.subarray(0, 1024).indexOf(PDF_SIGNATURE) !== -1;
}

export function freezeRecord(record) { return Object.freeze({ ...record }); }

export function assertOpaqueId(id) {
  if (!OPAQUE_ID.test(String(id ?? ''))) throw new HostError('INVALID_ID', 'Invalid local resource identifier.', 400);
}

export function insideStore(state, kind, id) {
  assertOpaqueId(id);
  const parent = resolve(state.root, kind);
  const target = resolve(parent, id);
  if (!target.startsWith(`${parent}${sep}`)) throw new HostError('INVALID_ID', 'Invalid local resource identifier.', 400);
  return target;
}

export function assertActive(state) {
  if (state.disposed) throw new HostError('STORE_DISPOSED', 'The local document store is closed.', 503);
}
