const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
const APPLICATION_VIEWS = new Set(['editor', 'workflows', 'plugins', 'trust']);

export function nextZoom(current, direction) {
  const value = Number(current);
  if (!Number.isFinite(value) || ![-1, 1].includes(direction)) {
    throw new TypeError('Zoom needs a finite value and a direction of -1 or 1.');
  }
  const stepped = value + direction * ZOOM_STEP;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stepped)) * 10) / 10;
}

export function nextRotation(current) {
  const normalized = Number(current);
  if (!Number.isInteger(normalized) || normalized % 90 !== 0) {
    throw new TypeError('Rotation must be an integer multiple of 90 degrees.');
  }
  return ((normalized + 90) % 360 + 360) % 360;
}

export function fileFromDrop(event) {
  return event?.dataTransfer?.files?.[0] ?? null;
}

export async function requestElementFullscreen(element) {
  if (!element || typeof element.requestFullscreen !== 'function') {
    throw new Error('Fullscreen is unavailable for this document surface.');
  }
  await element.requestFullscreen();
}

export function transitionApplicationView(currentView, nextView, onChange) {
  if (!APPLICATION_VIEWS.has(currentView) || !APPLICATION_VIEWS.has(nextView)) {
    throw new TypeError('Application views must be editor, workflows, plugins, or trust.');
  }
  if (currentView !== nextView) {
    if (typeof onChange !== 'function') {
      throw new TypeError('A view-change cleanup callback is required.');
    }
    onChange();
  }
  return nextView;
}

export function pageNumberFromNavigationTarget(target, pageCount) {
  const rawPage = target?.dataset?.pageNumber;
  if (typeof rawPage !== 'string' || !/^[1-9][0-9]*$/.test(rawPage)
    || !Number.isSafeInteger(pageCount) || pageCount < 1) return null;
  const page = Number(rawPage);
  return Number.isSafeInteger(page) && page <= pageCount ? page : null;
}
