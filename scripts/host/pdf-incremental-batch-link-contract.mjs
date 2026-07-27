export const INCREMENTAL_BATCH_LINK_PROFILE = 'local-aec-batch-link-v1';
export const MAX_BATCH_LINKS = 50;
const MAX_COORDINATE = 1_000_000;

function invalid(message = 'Incremental batch-link request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_BATCH_LINK';
  return error;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`${label} must be an exact object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw invalid(`${label} has unsupported or missing keys.`);
  }
  return descriptors;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value)) throw invalid(`${label} must be a safe integer.`);
  return value;
}

function normalizeLink(value, index) {
  const item = exactObject(value, ['sourcePage', 'targetPage', 'rect'], `links[${index}]`);
  const sourcePage = integer(item.sourcePage.value, `links[${index}].sourcePage`);
  const targetPage = integer(item.targetPage.value, `links[${index}].targetPage`);
  const rect = exactObject(item.rect.value, ['left', 'bottom', 'right', 'top'], `links[${index}].rect`);
  const normalizedRect = Object.freeze({
    left: integer(rect.left.value, `links[${index}].rect.left`),
    bottom: integer(rect.bottom.value, `links[${index}].rect.bottom`),
    right: integer(rect.right.value, `links[${index}].rect.right`),
    top: integer(rect.top.value, `links[${index}].rect.top`),
  });
  if (sourcePage < 1 || targetPage < 1 || sourcePage > 100 || targetPage > 100
    || Object.values(normalizedRect).some((number) => Math.abs(number) > MAX_COORDINATE)
    || normalizedRect.left >= normalizedRect.right || normalizedRect.bottom >= normalizedRect.top) {
    throw invalid(`links[${index}] is outside the bounded page or rectangle limits.`);
  }
  return Object.freeze({ sourcePage, targetPage, rect: normalizedRect });
}

export function normalizeIncrementalBatchGoToLinks(value) {
  const request = exactObject(value, ['profile', 'links'], 'batch-link request');
  if (request.profile.value !== INCREMENTAL_BATCH_LINK_PROFILE) throw invalid('The batch-link profile is unsupported.');
  const links = request.links.value;
  if (!Array.isArray(links) || Object.getPrototypeOf(links) !== Array.prototype
    || links.length < 1 || links.length > MAX_BATCH_LINKS
    || Object.keys(links).length !== links.length) throw invalid('links must contain 1 through 50 exact records.');
  const normalized = links.map((link, index) => normalizeLink(link, index));
  const seen = new Set();
  for (const link of normalized) {
    const key = `${link.sourcePage}:${link.targetPage}:${link.rect.left},${link.rect.bottom},${link.rect.right},${link.rect.top}`;
    if (seen.has(key)) throw invalid('Duplicate batch-link records are not allowed.');
    seen.add(key);
  }
  return Object.freeze({ profile: INCREMENTAL_BATCH_LINK_PROFILE, links: Object.freeze(normalized) });
}

