export const INCREMENTAL_PAGE_TRANSITION_PROFILE = 'local-classic-incremental-page-transition-v1';
export const PDF_PAGE_TRANSITION_PROFILE = INCREMENTAL_PAGE_TRANSITION_PROFILE;
export const PDF_INCREMENTAL_PAGE_TRANSITION_PROFILE = INCREMENTAL_PAGE_TRANSITION_PROFILE;

const MAX_PAGES = 100;
const MAX_DURATION = 60;

function invalid(message = 'Incremental PDF page-transition request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_PAGE_TRANSITION';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => (
      !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    ))) throw invalid();
  return descriptors;
}

function exactArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Number.isSafeInteger(descriptors.length?.value)
    || Object.keys(descriptors).length !== descriptors.length.value + 1) throw invalid();
  return descriptors;
}

export function normalizeIncrementalPageTransition(value) {
  const request = exactObject(value, ['profile', 'pages', 'transition', 'duration']);
  if (request.profile.value !== INCREMENTAL_PAGE_TRANSITION_PROFILE
    || request.transition.value !== 'Dissolve') throw invalid();
  const pages = request.pages.value;
  const pageDescriptors = exactArray(pages);
  if (pages.length < 1 || pages.length > MAX_PAGES) throw invalid();
  const normalizedPages = [];
  let previous = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const descriptor = pageDescriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid();
    const page = descriptor.value;
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES || page <= previous) {
      throw invalid('Transition pages must be unique, strictly ascending one-based integers.');
    }
    normalizedPages.push(page); previous = page;
  }
  const duration = request.duration.value;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration * 1000 !== Math.round(duration * 1000)
    || duration < 0 || duration > MAX_DURATION) throw invalid('Transition duration must be a finite number from 0 through 60 seconds at millisecond precision.');
  return Object.freeze({
    profile: INCREMENTAL_PAGE_TRANSITION_PROFILE,
    pages: Object.freeze(normalizedPages),
    transition: 'Dissolve',
    duration,
  });
}
