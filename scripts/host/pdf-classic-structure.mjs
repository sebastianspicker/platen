import {
  findFinalStartXref,
  parseClassicXrefSection,
  parsePdfIndirectObject,
  pdfDictionary,
  pdfInteger,
  pdfReference,
  pdfStringBytes,
} from './pdf-classic-syntax.mjs';
import { parseGenericReferencedObjects } from './pdf-generic-object-parser.mjs';
import { parseXrefStreamSection } from './pdf-xref-stream.mjs';
import { parsePdfObjectStream } from './pdf-object-stream.mjs';
import {
  brandPdfStructure,
  copyResolvedPdfObject,
  exposedPdfObjectMap,
  pdfStructureAuthority,
} from './pdf-structure-authority.mjs';

const TRAILER_KEYS = new Set(['Size', 'Root', 'Info', 'ID', 'Prev']);
export const CLASSIC_PDF_STRUCTURE_LIMITS = Object.freeze({
  maxRevisions: 32,
  maxTotalXrefEntries: 50_000,
  maxObjectNumber: 1_000_000,
});

function invalid() {
  const error = new Error('PDF is not in the supported bounded classic-xref form.');
  error.code = 'INVALID_CLASSIC_PDF_STRUCTURE';
  return error;
}

function validateId(value) {
  if (value?.type !== 'array' || value.values.length !== 2) throw invalid();
  return Object.freeze(value.values.map((entry) => Buffer.from(pdfStringBytes(entry))));
}

function collectRevisions(buffer, syntaxBudget) {
  const revisions = []; const visited = new Set(); let totalEntries = 0;
  let offset = findFinalStartXref(buffer);
  for (let depth = 0; depth < CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions; depth += 1) {
    if (visited.has(offset)) throw invalid();
    visited.add(offset);
    const section = parseClassicXrefSection(buffer, offset, syntaxBudget);
    totalEntries += section.entries.length;
    if (totalEntries > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw invalid();
    if ([...section.trailer.keys()].some((key) => !TRAILER_KEYS.has(key))) throw invalid();
    const size = pdfInteger(section.trailer.get('Size'));
    if (size < 1 || section.entries.some((entry) => entry.object >= size)) throw invalid();
    if (section.trailer.has('Root')) pdfReference(section.trailer.get('Root'));
    if (section.trailer.has('Info')) pdfReference(section.trailer.get('Info'));
    if (section.trailer.has('ID')) validateId(section.trailer.get('ID'));
    revisions.push(Object.freeze({ ...section, size }));
    if (!section.trailer.has('Prev')) return Object.freeze(revisions);
    const previous = pdfInteger(section.trailer.get('Prev'));
    if (previous < 0 || previous >= offset) throw invalid();
    offset = previous;
  }
  throw invalid();
}

function effectiveValue(revisions, key) {
  for (const revision of revisions) if (revision.trailer.has(key)) return revision.trailer.get(key);
  return null;
}

function parseReferencedObjects(buffer, revisions, syntaxBudget) {
  const parsed = new Map(); const spans = [];
  for (const revision of revisions) {
    for (const entry of revision.entries) {
      if (entry.status !== 'n') continue;
      const key = `${entry.object}:${entry.generation}:${entry.offset}`;
      if (parsed.has(key)) continue;
      const object = parsePdfIndirectObject(buffer, entry.offset, entry, syntaxBudget);
      if (object.end > revision.offset) throw invalid();
      parsed.set(key, object); spans.push(object);
    }
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  if (spans.some((span) => revisions.some(
    (revision) => span.start < revision.revisionEnd && span.end > revision.offset,
  ))) throw invalid();
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]; const current = spans[index];
    if (current.start < previous.end
      && (current.start !== previous.start || current.end !== previous.end)) throw invalid();
  }
  return parsed;
}

function buildEffectiveEntries(revisions) {
  const effective = new Map();
  for (const revision of revisions) {
    for (const entry of revision.entries) if (!effective.has(entry.object)) effective.set(entry.object, entry);
  }
  return effective;
}

function validateChronology(revisions, objects) {
  const effective = new Map();
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    const bodyStart = index === revisions.length - 1 ? 0 : revisions[index + 1].revisionEnd;
    for (const entry of revision.entries) {
      if (entry.status !== 'n') continue;
      const previous = effective.get(entry.object);
      const repeated = previous?.status === 'n' && previous.generation === entry.generation
        && previous.offset === entry.offset;
      const object = objects.get(`${entry.object}:${entry.generation}:${entry.offset}`);
      const introducedHere = object && object.start >= bodyStart && object.end <= revision.offset;
      if (!repeated && !introducedHere) throw invalid();
    }
    for (const entry of revision.entries) effective.set(entry.object, entry);
  }
}

function genericCollectRevisions(buffer, syntaxBudget) {
  const revisions = []; const visited = new Set(); let totalEntries = 0;
  let offset = findFinalStartXref(buffer);
  for (let depth = 0; depth < CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions; depth += 1) {
    if (visited.has(offset)) throw invalid();
    visited.add(offset);
    const stream = !/^xref(?:\x00|\x09|\x0a|\x0c|\x0d|\x20)/.test(buffer.subarray(offset, offset + 6).toString('latin1'));
    const section = stream
      ? parseXrefStreamSection(buffer, offset, syntaxBudget)
      : parseClassicXrefSection(buffer, offset, syntaxBudget);
    totalEntries += section.entries.length;
    if (totalEntries > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries
      || [...section.trailer.keys()].some((key) => !TRAILER_KEYS.has(key)
        && !(stream && ['Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms'].includes(key)))) throw invalid();
    const size = stream ? section.size : pdfInteger(section.trailer.get('Size'));
    if (size < 1 || section.entries.some((entry) => entry.object >= size)) throw invalid();
    if (section.trailer.has('Root')) pdfReference(section.trailer.get('Root'));
    if (section.trailer.has('Info')) pdfReference(section.trailer.get('Info'));
    if (section.trailer.has('ID')) validateId(section.trailer.get('ID'));
    revisions.push(Object.freeze({ ...section, size, xrefKind: stream ? 'stream' : 'classic' }));
    if (!section.trailer.has('Prev')) return Object.freeze(revisions);
    const previous = pdfInteger(section.trailer.get('Prev'));
    if (previous < 0 || previous >= offset) throw invalid();
    offset = previous;
  }
  throw invalid();
}

function validateGenericChronology(revisions, objects) {
  const effective = new Map();
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    const bodyStart = index === revisions.length - 1 ? 0 : revisions[index + 1].revisionEnd;
    for (const entry of revision.entries) {
      if (entry.status !== 'n') continue;
      const previous = effective.get(entry.object);
      const repeated = previous?.status === 'n' && previous.generation === entry.generation
        && previous.offset === entry.offset;
      const object = objects.get(`${entry.object}:${entry.generation}:${entry.offset}`);
      const control = revision.xrefKind === 'stream' && entry.object === revision.xrefReference.object;
      const introducedHere = control
        ? object && object.start === revision.offset && object.end <= revision.revisionEnd
        : object && object.start >= bodyStart && object.end <= revision.offset;
      if (!repeated && !introducedHere) throw invalid();
    }
    for (const entry of revision.entries) effective.set(entry.object, entry);
  }
}

function bindCompressedObjects(buffer, revisions, objects, syntaxBudget) {
  const compressed = new Map(); const controls = new Set();
  const knownContainers = new Map(); const priorEntries = new Map();
  for (let revisionIndex = revisions.length - 1; revisionIndex >= 0; revisionIndex -= 1) {
    const revision = revisions[revisionIndex];
    const bodyStart = revisionIndex === revisions.length - 1 ? 0 : revisions[revisionIndex + 1].revisionEnd;
    const containers = new Map();
    for (const entry of revision.entries) {
      if (entry.status !== 'n') continue;
      const object = objects.get(`${entry.object}:${entry.generation}:${entry.offset}`);
      if (object?.stream && object.value?.type === 'dict'
        && object.value.entries.get('Type')?.type === 'name'
        && object.value.entries.get('Type').value === 'ObjStm') {
        if (entry.generation !== 0 || object.start < bodyStart
          || knownContainers.has(entry.object) || priorEntries.has(entry.object)) throw invalid();
        containers.set(entry.object, object); controls.add(entry.object);
      }
      if (knownContainers.has(entry.object)) throw invalid();
    }
    const rowsByContainer = new Map();
    for (const entry of revision.entries) if (entry.status === 'c') {
      const rows = rowsByContainer.get(entry.objectStream) ?? [];
      rows.push(entry); rowsByContainer.set(entry.objectStream, rows);
    }
    for (const number of containers.keys()) if (!rowsByContainer.has(number)) throw invalid();
    for (const [number, rows] of rowsByContainer) {
      const container = containers.get(number);
      const known = knownContainers.get(number);
      if (!container && !known) throw invalid();
      if (!container) {
        for (const entry of rows) {
          const prior = priorEntries.get(entry.object);
          if (prior?.status !== 'c' || prior.objectStream !== number || prior.index !== entry.index) throw invalid();
          compressed.set(entry, compressed.get(prior));
        }
        continue;
      }
      const members = parsePdfObjectStream(
        Object.freeze({ ...container, buffer }),
        syntaxBudget,
      );
      if (members.length !== rows.length) throw invalid();
      const seen = new Set();
      for (const entry of rows) {
        const member = members[entry.index];
        if (!member || member.object !== entry.object || entry.object === number || seen.has(entry.index)
          || priorEntries.has(entry.object)) throw invalid();
        seen.add(entry.index);
        compressed.set(entry, Object.freeze({
          reference: Object.freeze({ object: entry.object, generation: 0 }), value: member.value,
          stream: false, compressed: true,
          storage: Object.freeze({
            kind: 'compressed', revisionOffset: revision.offset,
            objectStream: Object.freeze({ object: number, generation: 0 }),
            objectStreamOffset: container.start, index: entry.index,
            decodedStart: member.decodedStart, decodedEnd: member.decodedEnd,
            filter: member.filter,
            ...(member.predictor ? { predictor: member.predictor } : {}),
          }),
        }));
      }
      knownContainers.set(number, container);
    }
    for (const entry of revision.entries) priorEntries.set(entry.object, entry);
  }
  return Object.freeze({ compressed, controls: Object.freeze(controls) });
}

export function parsePdfStructure(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)
      || !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(buffer.subarray(0, 10).toString('latin1'))) throw invalid();
    const syntaxBudget = { items: 0, decodedBytes: 0, xrefEncodedBytes: 0, xrefFilterWorkBytes: 0,
      objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0, objectFilterWorkBytes: 0 };
    const revisions = genericCollectRevisions(buffer, syntaxBudget);
    const finalSize = revisions[0].size;
    if (finalSize >= CLASSIC_PDF_STRUCTURE_LIMITS.maxObjectNumber
      || revisions.some((revision) => revision.entries.some((entry) => entry.object >= finalSize))) throw invalid();
    const baseObjectZero = revisions.at(-1).entries.find((entry) => entry.object === 0);
    if (!baseObjectZero || baseObjectZero.status !== 'f' || baseObjectZero.generation !== 65_535
      || revisions.some((revision, index) => index + 1 < revisions.length
        && revision.size < revisions[index + 1].size)
      || revisions.some((revision, index) => index + 1 < revisions.length
        && revisions[index + 1].revisionEnd > revision.offset)) throw invalid();
    const root = pdfReference(effectiveValue(revisions, 'Root'));
    const infoValue = effectiveValue(revisions, 'Info');
    const info = infoValue === null ? null : pdfReference(infoValue);
    const idValue = effectiveValue(revisions, 'ID');
    const id = idValue === null ? null : validateId(idValue);
    for (const revision of revisions) if (revision.trailer.has('ID') && id
      && !validateId(revision.trailer.get('ID'))[0].equals(id[0])) throw invalid();
    const objects = parseGenericReferencedObjects(buffer, revisions, syntaxBudget);
    validateGenericChronology(revisions, objects);
    const effective = buildEffectiveEntries(revisions);
    if ([...effective.values()].some((entry) => ['n', 'c'].includes(entry.status) && entry.object >= finalSize)) throw invalid();
    const bound = bindCompressedObjects(buffer, revisions, objects, syntaxBudget);
    const controlObjectNumbers = Object.freeze(new Set([
      ...revisions.filter((revision) => revision.xrefKind === 'stream').map((revision) => revision.xrefReference.object),
      ...bound.controls,
    ]));
    const structure = brandPdfStructure({
      buffer, revisions, finalSize, root, info, id,
      effective: new Map(effective), objects: exposedPdfObjectMap(objects),
      compressedObjects: exposedPdfObjectMap(bound.compressed), controlObjectNumbers,
      compressedObjectVersions: new Set(bound.compressed.values()).size,
      xrefFlavor: revisions.some((revision) => revision.xrefKind === 'stream') ? 'stream' : 'classic',
    }, {
      effective,
      objects,
      compressedObjects: bound.compressed,
      controlObjectNumbers: new Set(controlObjectNumbers),
    }, 'generic');
    const catalog = resolvePdfObject(structure, root);
    const catalogEntries = pdfDictionary(catalog.value);
    const catalogType = catalogEntries.get('Type');
    if (catalog.stream === true || catalogType?.type !== 'name' || catalogType.value !== 'Catalog'
      || catalogEntries.has('Perms')) throw invalid();
    if (info) { const infoObject = resolvePdfObject(structure, info); if (infoObject.stream) throw invalid(); pdfDictionary(infoObject.value); }
    return structure;
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_PDF_STRUCTURE') throw error;
    throw invalid();
  }
}

export function resolvePdfObject(structure, reference) {
  try {
    const normalized = pdfReference(reference);
    const authority = pdfStructureAuthority(structure, 'generic');
    const entry = authority?.effective.get(normalized.object);
    if (!entry || !['n', 'c'].includes(entry.status) || entry.generation !== normalized.generation) throw invalid();
    const object = entry.status === 'c'
      ? authority.compressedObjects.get(entry)
      : authority.objects.get(`${entry.object}:${entry.generation}:${entry.offset}`);
    if (!object) throw invalid();
    return copyResolvedPdfObject(object);
  } catch { throw invalid(); }
}

export function resolveClassicPdfObject(structure, reference) {
  try {
    const normalized = pdfReference(reference);
    const authority = pdfStructureAuthority(structure, 'classic');
    const entry = authority?.effective.get(normalized.object);
    if (!entry || entry.status !== 'n' || entry.generation !== normalized.generation) throw invalid();
    const object = authority.objects.get(`${entry.object}:${entry.generation}:${entry.offset}`);
    if (!object) throw invalid();
    return copyResolvedPdfObject(object);
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_PDF_STRUCTURE') throw error;
    throw invalid();
  }
}

export function parseClassicPdfStructure(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)
      || !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(buffer.subarray(0, 10).toString('latin1'))) throw invalid();
    const syntaxBudget = { items: 0, decodedBytes: 0 };
    const revisions = collectRevisions(buffer, syntaxBudget);
    const finalSize = revisions[0].size;
    if (finalSize >= CLASSIC_PDF_STRUCTURE_LIMITS.maxObjectNumber
      || revisions.some((revision) => revision.entries.some((entry) => entry.object >= finalSize))) throw invalid();
    const baseObjectZero = revisions.at(-1).entries.find((entry) => entry.object === 0);
    if (!baseObjectZero || baseObjectZero.status !== 'f' || baseObjectZero.generation !== 65_535
      || revisions.some((revision, index) => index + 1 < revisions.length
        && revision.size < revisions[index + 1].size)
      || revisions.some((revision, index) => index + 1 < revisions.length
        && revisions[index + 1].revisionEnd > revision.offset)) throw invalid();
    const root = pdfReference(effectiveValue(revisions, 'Root'));
    const infoValue = effectiveValue(revisions, 'Info');
    const info = infoValue === null ? null : pdfReference(infoValue);
    const idValue = effectiveValue(revisions, 'ID');
    const id = idValue === null ? null : validateId(idValue);
    for (const revision of revisions) {
      if (revision.trailer.has('ID') && id && !validateId(revision.trailer.get('ID'))[0].equals(id[0])) throw invalid();
    }
    const objects = parseReferencedObjects(buffer, revisions, syntaxBudget);
    validateChronology(revisions, objects);
    const effective = buildEffectiveEntries(revisions);
    const structure = brandPdfStructure({
      buffer, revisions, finalSize, root, info, id,
      effective: new Map(effective), objects: exposedPdfObjectMap(objects),
    }, { effective, objects }, 'classic');
    if ([...structure.effective.values()].some((entry) => entry.status === 'n' && entry.object >= finalSize)) throw invalid();
    const catalog = resolveClassicPdfObject(structure, root);
    const catalogEntries = pdfDictionary(catalog.value);
    const catalogType = catalogEntries.get('Type');
    if (catalog.stream === true || catalogType?.type !== 'name' || catalogType.value !== 'Catalog'
      || catalogEntries.has('Perms')) throw invalid();
    if (info) {
      const infoObject = resolveClassicPdfObject(structure, info);
      if (infoObject.stream === true) throw invalid();
      pdfDictionary(infoObject.value);
    }
    return structure;
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_PDF_STRUCTURE') throw error;
    throw invalid();
  }
}
