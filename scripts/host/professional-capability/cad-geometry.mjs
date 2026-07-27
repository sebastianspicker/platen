import { HostError } from '../host-error.mjs';
import { createTextPdf } from '../pdf-factory.mjs';
import { createHash } from 'node:crypto';

const MAX_PAGE_POINTS = 14_400;
const MIN_PAGE_POINTS = 72;
const MAX_CAD_ENTITIES = 2_000;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseCadEntities(sourceBytes) {
  const asText = sourceBytes.toString('utf8').replace(/^\uFEFF/, '');
  let width = 612;
  let height = 792;
  let title = 'CAD conversion';
  const entities = [];

  if (asText.trimStart().startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(asText); }
    catch (error) { throw new HostError('INVALID_CAD_INPUT', 'CAD JSON geometry is malformed.', 415, { cause: error }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.entities)) {
      throw new HostError('INVALID_CAD_INPUT', 'CAD JSON requires an entities array.', 415);
    }
    width = Number.isFinite(parsed.width) ? parsed.width : width;
    height = Number.isFinite(parsed.height) ? parsed.height : height;
    title = typeof parsed.title === 'string' ? parsed.title : title;
    for (const entity of parsed.entities.slice(0, MAX_CAD_ENTITIES)) {
      if (!entity || typeof entity !== 'object') continue;
      if (entity.type === 'line' && [entity.x1, entity.y1, entity.x2, entity.y2].every((n) => Number.isFinite(n))) {
        entities.push({ type: 'line', x1: entity.x1, y1: entity.y1, x2: entity.x2, y2: entity.y2 });
      } else if (entity.type === 'rect' && [entity.x, entity.y, entity.width, entity.height].every((n) => Number.isFinite(n))) {
        entities.push({ type: 'rect', x: entity.x, y: entity.y, width: entity.width, height: entity.height });
      } else if (entity.type === 'circle' && [entity.x, entity.y, entity.r].every((n) => Number.isFinite(n))) {
        entities.push({ type: 'circle', x: entity.x, y: entity.y, r: entity.r });
      }
    }
  } else if (/^(?:0\s*(?:\r?\n)+\s*SECTION\b|999\b)/i.test(asText.trimStart()) || asText.includes('SECTION')) {
    const lines = asText.split(/\r?\n/);
    let i = 0;
    while (i < lines.length - 1 && entities.length < MAX_CAD_ENTITIES) {
      const code = lines[i].trim();
      const value = lines[i + 1]?.trim() ?? '';
      i += 2;
      if (code === '0' && value === 'LINE') {
        const coords = { x1: null, y1: null, x2: null, y2: null };
        while (i < lines.length - 1) {
          const c = lines[i].trim();
          const v = lines[i + 1]?.trim() ?? '';
          if (c === '0') break;
          i += 2;
          if (c === '10') coords.x1 = Number(v);
          else if (c === '20') coords.y1 = Number(v);
          else if (c === '11') coords.x2 = Number(v);
          else if (c === '21') coords.y2 = Number(v);
        }
        if ([coords.x1, coords.y1, coords.x2, coords.y2].every((n) => Number.isFinite(n))) {
          entities.push({ type: 'line', ...coords });
        }
      }
    }
  } else {
    throw new HostError('UNSUPPORTED_CAD_INPUT', 'Local CAD conversion accepts DXF LINE subsets or JSON geometric descriptions only.', 415);
  }

  if (entities.length === 0) {
    throw new HostError('EMPTY_CAD_GEOMETRY', 'CAD input contained no supported drawable entities.', 422);
  }
  width = Math.min(MAX_PAGE_POINTS, Math.max(MIN_PAGE_POINTS, Number(width) || 612));
  height = Math.min(MAX_PAGE_POINTS, Math.max(MIN_PAGE_POINTS, Number(height) || 792));
  return { entities, width, height, title };
}

export function cadSourceToPdf(sourceBytes, options = {}) {
  const parsed = parseCadEntities(sourceBytes);
  const width = options.widthPoints ?? parsed.width;
  const height = options.heightPoints ?? parsed.height;
  const title = options.title ?? parsed.title;
  const description = parsed.entities.map((entity, index) => `${index + 1}. ${entity.type}`).join('\n');
  const bytes = createTextPdf({
    text: `CAD conversion\n${description}`,
    title,
    widthPoints: width,
    heightPoints: height,
  });
  return {
    bytes,
    pageCount: 1,
    size: bytes.length,
    sha256: digest(bytes),
    mediaType: 'application/pdf',
    entityCount: parsed.entities.length,
    width,
    height,
  };
}
