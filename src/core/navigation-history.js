function validPage(page) {
  return Number.isSafeInteger(page) && page > 0;
}

function navigationLimit(limit) {
  return Number.isSafeInteger(limit) && limit >= 2 ? Math.min(limit, 1_000) : 100;
}

function boundedHistory(history, index, maximum) {
  if (!Array.isArray(history) || !history.length || !history.every(validPage)) return null;
  const current = Number.isSafeInteger(index) && index >= 0 && index < history.length
    ? index : history.length - 1;
  if (history.length <= maximum) return { history: [...history], index: current };
  const removed = history.length - maximum;
  const bounded = history.slice(removed);
  return {
    history: bounded,
    index: current >= removed ? current - removed : bounded.length - 1,
  };
}

export function resetPageNavigation() {
  return Object.freeze({ history: Object.freeze([1]), index: 0, page: 1 });
}

export function recordPageNavigation(history, index, page, { limit = 100 } = {}) {
  if (!validPage(page)) throw new TypeError('Navigation page must be a positive integer.');
  const maximum = navigationLimit(limit);
  const normalized = boundedHistory(history, index, maximum) ?? { history: [page], index: 0 };
  const source = normalized.history;
  const current = normalized.index;
  if (source[current] === page) return Object.freeze({ history: Object.freeze([...source]), index: current, page });
  const next = [...source.slice(0, current + 1), page];
  if (next.length > maximum) next.splice(0, next.length - maximum);
  return Object.freeze({ history: Object.freeze(next), index: next.length - 1, page });
}

export function movePageNavigation(history, index, offset) {
  if (!Array.isArray(history) || !history.length || !history.every(validPage)) return null;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset)) return null;
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= history.length) return null;
  return Object.freeze({ history: Object.freeze([...history]), index: nextIndex, page: history[nextIndex] });
}

export function transitionPageNavigation(history, index, currentPage, page, {
  pageCount,
  record = true,
  targetIndex = null,
  limit = 100,
} = {}) {
  if (!validPage(currentPage) || !Number.isSafeInteger(pageCount) || pageCount < 1
    || !validPage(page) || page > pageCount || typeof record !== 'boolean') return null;
  const maximum = navigationLimit(limit);
  const normalized = boundedHistory(history, index, maximum) ?? { history: [currentPage], index: 0 };
  if (page === currentPage) {
    return Object.freeze({
      changed: false,
      history: Object.freeze(normalized.history),
      index: normalized.index,
      page,
    });
  }
  if (record) {
    const next = recordPageNavigation(normalized.history, normalized.index, page, { limit: maximum });
    return Object.freeze({ changed: true, history: next.history, index: next.index, page });
  }
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= normalized.history.length
    || normalized.history[targetIndex] !== page) return null;
  return Object.freeze({
    changed: true,
    history: Object.freeze(normalized.history),
    index: targetIndex,
    page,
  });
}
