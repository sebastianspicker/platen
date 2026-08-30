export function documentEndpointPath(documentId, suffix) {
  return `/api/documents/${encodeURIComponent(documentId)}${suffix}`;
}

export function postJson(json, path, body, signal) {
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
