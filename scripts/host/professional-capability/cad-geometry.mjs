import { HostError } from '../host-error.mjs';
import { pdfString } from '../pdf-factory.mjs';
import { createHash } from 'node:crypto';

const MAX_PAGE_POINTS = 14_400;
const MIN_PAGE_POINTS = 72;
const MAX_CAD_ENTITIES = 2_000;

function invalidGeometry(message) {
  throw new HostError('INVALID_CAD_GEOMETRY', message, 422);
}

function coordinate(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < 0 || value > MAX_PAGE_POINTS) {
    invalidGeometry(`${field} must be a finite coordinate between 0 and ${MAX_PAGE_POINTS}.`);
  }
  return value;
}

function positiveExtent(value, field) {
  coordinate(value, field);
  if (value <= 0) invalidGeometry(`${field} must be greater than zero.`);
  return value;
}

function boundedSum(left, right, field) {
  const value = left + right;
  if (!Number.isFinite(value) || value > MAX_PAGE_POINTS) {
    invalidGeometry(`${field} exceeds the bounded CAD coordinate range.`);
  }
  return value;
}

function boundedDifference(left, right, field) {
  const value = left - right;
  if (!Number.isFinite(value) || value < 0) {
    invalidGeometry(`${field} produces unsupported negative CAD geometry.`);
  }
  return value;
}

function pageDimension(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < MIN_PAGE_POINTS || value > MAX_PAGE_POINTS) {
    invalidGeometry(`${field} must be a finite page dimension between ${MIN_PAGE_POINTS} and ${MAX_PAGE_POINTS}.`);
  }
  return value;
}

function validatedEntity(entity) {
  if (entity.type === 'line') {
    return {
      type: 'line',
      x1: coordinate(entity.x1, 'line.x1'),
      y1: coordinate(entity.y1, 'line.y1'),
      x2: coordinate(entity.x2, 'line.x2'),
      y2: coordinate(entity.y2, 'line.y2'),
    };
  }
  if (entity.type === 'rect') {
    const x = coordinate(entity.x, 'rect.x');
    const y = coordinate(entity.y, 'rect.y');
    const width = positiveExtent(entity.width, 'rect.width');
    const height = positiveExtent(entity.height, 'rect.height');
    boundedSum(x, width, 'rect.x + rect.width');
    boundedSum(y, height, 'rect.y + rect.height');
    return { type: 'rect', x, y, width, height };
  }
  if (entity.type === 'circle') {
    const x = coordinate(entity.x, 'circle.x');
    const y = coordinate(entity.y, 'circle.y');
    const r = positiveExtent(entity.r, 'circle.r');
    boundedDifference(x, r, 'circle.x - circle.r');
    boundedDifference(y, r, 'circle.y - circle.r');
    boundedSum(x, r, 'circle.x + circle.r');
    boundedSum(y, r, 'circle.y + circle.r');
    return { type: 'circle', x, y, r };
  }
  return null;
}

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
    if (Object.hasOwn(parsed, 'width')) width = pageDimension(parsed.width, 'width');
    if (Object.hasOwn(parsed, 'height')) height = pageDimension(parsed.height, 'height');
    title = typeof parsed.title === 'string' ? parsed.title : title;
    for (const entity of parsed.entities.slice(0, MAX_CAD_ENTITIES)) {
      if (!entity || typeof entity !== 'object') continue;
      const validated = validatedEntity(entity);
      if (validated) entities.push(validated);
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
        entities.push(validatedEntity({ type: 'line', ...coords }));
      }
    }
  } else {
    throw new HostError('UNSUPPORTED_CAD_INPUT', 'Local CAD conversion accepts DXF LINE subsets or JSON geometric descriptions only.', 415);
  }

  if (entities.length === 0) {
    throw new HostError('EMPTY_CAD_GEOMETRY', 'CAD input contained no supported drawable entities.', 422);
  }
  return { entities, width, height, title };
}

export function cadEntitiesToPdf(entities, options = {}) {
  if (!Array.isArray(entities) || entities.length < 1 || entities.length > MAX_CAD_ENTITIES) {
    invalidGeometry(`CAD rendering requires one through ${MAX_CAD_ENTITIES} supported entities.`);
  }
  const normalized = entities.map((entity) => {
    const checked = validatedEntity(entity);
    if (!checked) invalidGeometry('CAD rendering received an unsupported entity.');
    return checked;
  });
  const width = pageDimension(options.widthPoints ?? 612, 'widthPoints');
  const height = pageDimension(options.heightPoints ?? 792, 'heightPoints');
  const title = options.title ?? 'CAD conversion';
  const number = (value) => String(Math.round(value * 1_000_000) / 1_000_000);
  const path = ['q', '0 0 0 RG', '1 w'];
  for (const entity of normalized) {
    if (entity.type === 'line') {
      path.push(`${number(entity.x1)} ${number(entity.y1)} m`);
      path.push(`${number(entity.x2)} ${number(entity.y2)} l`, 'S');
    } else if (entity.type === 'rect') {
      path.push(`${number(entity.x)} ${number(entity.y)} ${number(entity.width)} ${number(entity.height)} re`, 'S');
    } else if (entity.type === 'circle') {
      const k = entity.r * 0.552284749831;
      coordinate(k, 'circle Bézier control distance');
      const right = boundedSum(entity.x, entity.r, 'circle.x + circle.r');
      const left = boundedDifference(entity.x, entity.r, 'circle.x - circle.r');
      const top = boundedSum(entity.y, entity.r, 'circle.y + circle.r');
      const bottom = boundedDifference(entity.y, entity.r, 'circle.y - circle.r');
      const controlRight = boundedSum(entity.x, k, 'circle.x + circle Bézier control distance');
      const controlLeft = boundedDifference(entity.x, k, 'circle.x - circle Bézier control distance');
      const controlTop = boundedSum(entity.y, k, 'circle.y + circle Bézier control distance');
      const controlBottom = boundedDifference(entity.y, k, 'circle.y - circle Bézier control distance');
      path.push(`${number(right)} ${number(entity.y)} m`);
      path.push(`${number(right)} ${number(controlTop)} ${number(controlRight)} ${number(top)} ${number(entity.x)} ${number(top)} c`);
      path.push(`${number(controlLeft)} ${number(top)} ${number(left)} ${number(controlTop)} ${number(left)} ${number(entity.y)} c`);
      path.push(`${number(left)} ${number(controlBottom)} ${number(controlLeft)} ${number(bottom)} ${number(entity.x)} ${number(bottom)} c`);
      path.push(`${number(controlRight)} ${number(bottom)} ${number(right)} ${number(controlBottom)} ${number(right)} ${number(entity.y)} c`, 'S');
    }
  }
  path.push('Q');
  const stream = `${path.join('\n')}\n`;
  const chunks = ['%PDF-1.7\n'];
  const offsets = [];
  const object = (id, body) => {
    offsets[id] = Buffer.byteLength(chunks.join(''), 'latin1');
    chunks.push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] /Contents 4 0 R /Resources << >> >>`);
  object(4, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  object(5, `<< /Title (${pdfString(String(title).slice(0, 200))}) /Producer (Platen local CAD subset) >>`);
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id += 1) chunks.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const bytes = Buffer.from(chunks.join(''), 'latin1');
  return {
    bytes,
    pageCount: 1,
    size: bytes.length,
    sha256: digest(bytes),
    mediaType: 'application/pdf',
    entityCount: normalized.length,
    width,
    height,
  };
}

export function cadSourceToPdf(sourceBytes, options = {}) {
  const parsed = parseCadEntities(sourceBytes);
  return cadEntitiesToPdf(parsed.entities, {
    widthPoints: options.widthPoints ?? parsed.width,
    heightPoints: options.heightPoints ?? parsed.height,
    title: options.title ?? parsed.title,
  });
}
