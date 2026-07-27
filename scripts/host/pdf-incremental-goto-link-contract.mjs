export const INCREMENTAL_GOTO_LINK_PROFILE = 'local-incremental-goto-link-v1';

const MAX_COORDINATE = 1_000_000;

function invalid() {
  const error = new Error('Incremental PDF GoTo-link request is invalid.');
  error.code = 'INVALID_INCREMENTAL_GOTO_LINK';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw invalid();
  }
  return descriptors;
}

function integer(value) {
  if (!Number.isSafeInteger(value)) throw invalid();
  return value;
}

export function normalizeIncrementalGoToLink(value) {
  const request = exactObject(value, ['profile', 'sourcePage', 'targetPage', 'rect']);
  if (request.profile.value !== INCREMENTAL_GOTO_LINK_PROFILE) throw invalid();
  const sourcePage = integer(request.sourcePage.value);
  const targetPage = integer(request.targetPage.value);
  const rect = exactObject(request.rect.value, ['left', 'bottom', 'right', 'top']);
  const left = integer(rect.left.value); const bottom = integer(rect.bottom.value);
  const right = integer(rect.right.value); const top = integer(rect.top.value);
  if (sourcePage < 1 || targetPage < 1 || sourcePage > 100 || targetPage > 100
    || [left, bottom, right, top].some((number) => Math.abs(number) > MAX_COORDINATE)
    || left >= right || bottom >= top) throw invalid();
  return Object.freeze({
    profile: INCREMENTAL_GOTO_LINK_PROFILE,
    sourcePage,
    targetPage,
    rect: Object.freeze({ left, bottom, right, top }),
  });
}
