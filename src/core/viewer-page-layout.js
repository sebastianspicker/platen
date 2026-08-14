const PAGE_LAYOUT_VALUES = ['single', 'continuous', 'facing', 'cover-facing'];

export const VIEWER_PAGE_LAYOUTS = Object.freeze([...PAGE_LAYOUT_VALUES]);
export const MAX_CONTINUOUS_LAYOUT_PAGES = 32;

export function normalizeViewerPageLayout(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Viewer page layout must be a string.');
  }
  if (!VIEWER_PAGE_LAYOUTS.includes(value)) {
    throw new RangeError(`Unsupported viewer page layout: ${value}.`);
  }
  return value;
}

export function nextViewerPageLayout(value) {
  const current = normalizeViewerPageLayout(value);
  const index = VIEWER_PAGE_LAYOUTS.indexOf(current);
  return VIEWER_PAGE_LAYOUTS[(index + 1) % VIEWER_PAGE_LAYOUTS.length];
}

function exactLayoutRequest(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some((key) => !['layout', 'selectedPage', 'pageCount'].includes(key))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function pagePair(selectedPage, pageCount) {
  const first = selectedPage % 2 === 0 ? selectedPage - 1 : selectedPage;
  return first + 1 <= pageCount ? [first, first + 1] : [first];
}

export function resolveViewerPageLayout(value) {
  if (!exactLayoutRequest(value)) {
    throw new TypeError('Viewer page layout request must be an exact plain object.');
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Viewer page layout request must be an exact plain object.');
  }
  const layout = normalizeViewerPageLayout(descriptors.layout.value);
  const { selectedPage, pageCount } = descriptors;
  if (!Number.isSafeInteger(pageCount.value) || pageCount.value < 1 || pageCount.value > 10_000) {
    throw new RangeError('Viewer page layout pageCount must be a safe integer from 1 through 10000.');
  }
  if (!Number.isSafeInteger(selectedPage.value) || selectedPage.value < 1 || selectedPage.value > pageCount.value) {
    throw new RangeError('Viewer page layout selectedPage must be within pageCount.');
  }

  let pages;
  let truncated = false;
  if (layout === 'single') {
    pages = [selectedPage.value];
  } else if (layout === 'continuous') {
    const end = Math.min(pageCount.value, MAX_CONTINUOUS_LAYOUT_PAGES);
    pages = Array.from({ length: end }, (_, index) => index + 1);
    truncated = pageCount.value > MAX_CONTINUOUS_LAYOUT_PAGES;
  } else if (layout === 'facing') {
    pages = pagePair(selectedPage.value, pageCount.value);
  } else if (selectedPage.value === 1) {
    pages = [1];
  } else {
    const first = selectedPage.value % 2 === 0 ? selectedPage.value : selectedPage.value - 1;
    pages = first + 1 <= pageCount.value ? [first, first + 1] : [first];
  }

  return Object.freeze({ layout, pages: Object.freeze(pages), truncated });
}
