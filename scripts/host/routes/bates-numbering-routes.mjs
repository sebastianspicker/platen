import { HostError } from '../host-error.mjs';
import { PDF_BATES_NUMBERING_PROFILE } from '../pdf-bates-numbering-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIONS = new Set(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);
const exact = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value) => typeof value === 'string' && value === value.normalize('NFC') && [...value].length <= 64 && /^[\x20-\x7E]*$/u.test(value);
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export async function handleBatesNumberingRoute({ request, response, url, documentId, operation, processing, store, batesNumbering, bodyLimit, method, readJson, json }) {
  if (operation !== 'bates-numbering') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Bates numbering does not accept query parameters.', 400);
  if (!batesNumbering) throw new HostError('BATES_UNAVAILABLE', 'Bates numbering is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  const valid = exact(body, ['profile', 'sourceSha256', 'pages', 'start', 'prefix', 'suffix', 'padding', 'position', 'margin', 'fontSize']) && body.profile === PDF_BATES_NUMBERING_PROFILE && SHA256.test(body.sourceSha256 ?? '') && Array.isArray(body.pages) && body.pages.length >= 1 && body.pages.length <= 500 && body.pages.every((page, index) => Number.isSafeInteger(page) && page >= 1 && page <= 500 && (index === 0 || page > body.pages[index - 1])) && Number.isSafeInteger(body.start) && body.start >= 0 && body.start <= 999_999_999 && Number.isSafeInteger(body.padding) && body.padding >= 1 && body.padding <= 12 && text(body.prefix) && text(body.suffix) && POSITIONS.has(body.position) && number(body.margin, 0, 1_000_000) && number(body.fontSize, 0.000001, 200);
  if (!valid) throw new HostError('INVALID_BATES_OPTIONS', 'The Bates numbering request is invalid.', 400);
  const result = await batesNumbering.add(documentId, body, { signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
