import { ANNOTATION_TYPES, MAX_PAGE, MAX_RECORDS, csv, escapeXml, fail, integer, json, rect, string } from './review-forms-validation.mjs';

export function exportReviewJson(snapshot) {
  return {
    format: 'platen-review-v1',
    annotations: snapshot.namespaces.annotations.map(json),
    note: 'Prototype sidecar records; not embedded PDF annotations.',
  };
}

export function importReviewJson(workspace, documentId, interchange, expectedRevision) {
  const valid = interchange && interchange.format === 'platen-review-v1'
    && Array.isArray(interchange.annotations) && interchange.annotations.length <= MAX_RECORDS;
  if (!valid) fail('INVALID_INTERCHANGE', 'Invalid bounded review interchange.');
  return workspace.mutate(documentId, expectedRevision, (snapshot) => {
    for (const item of interchange.annotations) {
      const duplicate = item && snapshot.namespaces.annotations.some((annotation) => annotation.id === item.id);
      if (!item || typeof item !== 'object' || duplicate) {
        fail('INVALID_INTERCHANGE', 'Imported annotations must have unique identifiers.');
      }
      if (!ANNOTATION_TYPES.has(item.type)) {
        fail('INVALID_INTERCHANGE', 'Imported annotation type is unsupported.');
      }
      integer(item.page, 'page', 1, MAX_PAGE);
      rect(item.rectangle);
      string(item.text ?? '', 'text');
      snapshot.namespaces.annotations.push({
        ...json(item), prototypeSidecar: true, replies: Array.isArray(item.replies) ? item.replies.slice(0, 64) : [],
      });
    }
  });
}

export function reviewSummary(snapshot) {
  const annotations = snapshot.namespaces.annotations;
  const csvText = [
    'id,type,status,page,author,text',
    ...annotations.map((annotation) => [annotation.id, annotation.type, annotation.customStatus || annotation.status, annotation.page, annotation.author, annotation.text].map(csv).join(',')),
  ].join('\r\n');
  const records = annotations.map((annotation) => (
    `<text name="${escapeXml(annotation.id)}" page="${annotation.page - 1}" title="${escapeXml(annotation.author)}" contents="${escapeXml(annotation.text)}" subject="${escapeXml(annotation.type)}"/>`
  )).join('');
  return {
    xfdf: `<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>${records}</annots></xfdf>`,
    csv: csvText,
    commentSummary: annotations.map((annotation) => ({ id: annotation.id, status: annotation.customStatus || annotation.status, replies: annotation.replies.length, text: annotation.text })),
  };
}
