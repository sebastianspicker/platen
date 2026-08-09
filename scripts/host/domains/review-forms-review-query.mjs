import { ANNOTATION_TYPES, STATUSES, fail, json, string } from './review-forms-validation.mjs';

const GROUPING_FIELDS = new Set(['none', 'status', 'type', 'author', 'page']);
const SORT_FIELDS = new Set(['createdAt', 'page', 'status', 'type', 'author']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);

function validateQuery(search, status, type, groupBy, sortBy, direction) {
  string(search, 'search', { max: 256 });
  if (status !== undefined && !STATUSES.has(status)) fail('INVALID_STATUS', 'Unsupported annotation status.');
  if (type !== undefined && !ANNOTATION_TYPES.has(type)) {
    fail('INVALID_ANNOTATION_TYPE', 'Unsupported annotation type.');
  }
  if (!GROUPING_FIELDS.has(groupBy) || !SORT_FIELDS.has(sortBy) || !SORT_DIRECTIONS.has(direction)) {
    fail('INVALID_QUERY', 'Unsupported annotation query.');
  }
  return search.toLowerCase();
}

function matchesQuery(annotation, { status, type, needle }) {
  return (!status || annotation.status === status)
    && (!type || annotation.type === type)
    && (!needle || [annotation.text, annotation.author, annotation.status, annotation.customStatus ?? '']
      .join(' ').toLowerCase().includes(needle));
}

function queryCopies(records, filters) {
  return records.filter((annotation) => matchesQuery(annotation, filters)).map(json);
}

function sortAnnotations(list, sortBy, direction) {
  list.sort((left, right) => (
    String(left[sortBy] ?? '').localeCompare(String(right[sortBy] ?? '')) || left.id.localeCompare(right.id)
  ));
  if (direction === 'desc') list.reverse();
}

function groupAnnotations(list, groupBy) {
  return groupBy === 'none' ? list : Object.groupBy(list, (annotation) => String(annotation[groupBy] ?? ''));
}

export function queryAnnotations(snapshot, {
  search = '', status, type, groupBy = 'none', sortBy = 'createdAt', direction = 'asc',
} = {}) {
  const records = snapshot.namespaces.annotations;
  const needle = validateQuery(search, status, type, groupBy, sortBy, direction);
  const list = queryCopies(records, { status, type, needle });
  sortAnnotations(list, sortBy, direction);
  return groupAnnotations(list, groupBy);
}
