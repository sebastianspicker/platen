import {
  MAX_STREAM_BYTES,
  parseIndirectObjectHeader,
  parsePdfIndirectObject,
} from './pdf-classic-syntax.mjs';

function invalid() {
  const error = new Error('PDF is not in the supported bounded classic-xref form.');
  error.code = 'INVALID_CLASSIC_PDF_STRUCTURE';
  return error;
}

// Parses all indirect object bodies with one aggregate prepass budget. The
// prepass reads values and headers only, so indirect stream lengths can be
// resolved without searching arbitrary binary data for endstream markers.
export function parseGenericReferencedObjects(buffer, revisions, syntaxBudget) {
  const parsed = new Map(); const spans = []; const effective = new Map();
  for (const revision of revisions) for (const entry of revision.entries) {
    if (!effective.has(entry.object)) effective.set(entry.object, entry);
  }
  const headers = new Map(); const prepassBudget = { items: 0, decodedBytes: 0 };
  for (const revision of revisions) for (const entry of revision.entries) {
    if (entry.status !== 'n') continue;
    const key = `${entry.object}:${entry.generation}:${entry.offset}`;
    if (!headers.has(key)) headers.set(key, parseIndirectObjectHeader(buffer, entry.offset, entry, prepassBudget));
  }
  const resolveLength = (reference) => {
    const target = effective.get(reference.object);
    if (!target || target.status !== 'n' || target.generation !== reference.generation) throw invalid();
    const header = headers.get(`${target.object}:${target.generation}:${target.offset}`);
    if (!header || header.stream || header.value.type !== 'number' || !header.value.integer
      || header.value.value < 0 || header.value.value > MAX_STREAM_BYTES) throw invalid();
    return header.value.value;
  };
  for (const revision of revisions) {
    if (revision.xrefKind === 'stream') {
      const object = revision.xrefObject;
      parsed.set(`${object.reference.object}:${object.reference.generation}:${object.start}`, object);
      spans.push(object);
    }
    for (const entry of revision.entries) {
      if (entry.status !== 'n' || (revision.xrefKind === 'stream'
        && entry.object === revision.xrefReference.object)) continue;
      const key = `${entry.object}:${entry.generation}:${entry.offset}`;
      if (parsed.has(key)) continue;
      const object = parsePdfIndirectObject(buffer, entry.offset, entry, syntaxBudget, { resolveLength });
      if (object.end > revision.offset) throw invalid();
      parsed.set(key, object); spans.push(object);
    }
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]; const current = spans[index];
    if (current.start < previous.end && (current.start !== previous.start || current.end !== previous.end)) throw invalid();
  }
  for (const span of spans) for (const revision of revisions) {
    const control = revision.xrefKind === 'stream' && span.start === revision.xrefObject.start
      && span.end === revision.xrefObject.end;
    if (!control && span.start < revision.revisionEnd && span.end > revision.offset) throw invalid();
  }
  return parsed;
}
