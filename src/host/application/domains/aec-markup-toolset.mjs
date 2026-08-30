import {
  digest, fail, list, text,
} from './aec-collaboration-support.mjs';

function sourceBoundTools(tools) {
  const bounded = list(tools, 'tools', 50);
  if (bounded.length === 0) fail('INVALID_TOOLSET', 'Source-bound toolsets require at least one tool.');
  const normalized = bounded.map((tool) => text(tool, 'tool', 80));
  if (new Set(normalized).size !== normalized.length) {
    fail('INVALID_TOOLSET', 'Source-bound toolsets must not contain duplicate tools.');
  }
  return normalized;
}

export function createMarkupToolset(domain, documentId, {
  id: suppliedId, name, tools, sourceSha256,
}, options = {}) {
  if (sourceSha256 === undefined) {
    const record = {
      id: domain.newId('toolset', suppliedId),
      type: 'toolset',
      name: text(name, 'name'),
      tools: list(tools, 'tools', 50).map((tool) => text(tool, 'tool', 80)),
      createdAt: domain.now(),
    };
    return domain.write(documentId, 'metadata', record, options.expectedRevision);
  }

  const snapshot = domain.snapshot(documentId);
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0
    || options.expectedRevision !== snapshot.revision) {
    fail('REVISION_CONFLICT', 'Source-bound markup toolset creation requires the current workspace revision.', 409);
  }

  const safeSourceSha256 = digest(sourceSha256, 'sourceSha256');
  const normalizedTools = sourceBoundTools(tools);
  const record = {
    id: domain.newId('toolset', suppliedId),
    type: 'toolset',
    name: text(name, 'name'),
    tools: normalizedTools,
    sourceSha256: safeSourceSha256,
    basisRevision: snapshot.revision,
    createdAt: domain.now(),
  };
  return domain.write(documentId, 'metadata', record, options.expectedRevision);
}
