import { ANNOTATION_TYPES, STATUSES, fail, json, string } from './review-forms-validation.mjs';

export function queryAnnotations(snapshot, {
  search = '', status, type, groupBy = 'none', sortBy = 'createdAt', direction = 'asc',
} = {}) {
  const records = snapshot.namespaces.annotations;
  string(search, 'search', { max: 256 });
  if (status !== undefined && !STATUSES.has(status)) fail('INVALID_STATUS', 'Unsupported annotation status.');
  if (type !== undefined && !ANNOTATION_TYPES.has(type)) {
    fail('INVALID_ANNOTATION_TYPE', 'Unsupported annotation type.');
  }
  const validGrouping = ['none', 'status', 'type', 'author', 'page'].includes(groupBy);
  const validSort = ['createdAt', 'page', 'status', 'type', 'author'].includes(sortBy);
  const validDirection = ['asc', 'desc'].includes(direction);
  if (!validGrouping || !validSort || !validDirection) {
    fail('INVALID_QUERY', 'Unsupported annotation query.');
  }
  const needle = search.toLowerCase();
  const list = records.filter((annotation) => (
    (!status || annotation.status === status)
    && (!type || annotation.type === type)
    && (!needle || [annotation.text, annotation.author, annotation.status, annotation.customStatus ?? '']
      .join(' ').toLowerCase().includes(needle))
  )).map(json);
  list.sort((left, right) => (
    String(left[sortBy] ?? '').localeCompare(String(right[sortBy] ?? '')) || left.id.localeCompare(right.id)
  ));
  if (direction === 'desc') list.reverse();
  return groupBy === 'none' ? list : Object.groupBy(list, (annotation) => String(annotation[groupBy] ?? ''));
}
