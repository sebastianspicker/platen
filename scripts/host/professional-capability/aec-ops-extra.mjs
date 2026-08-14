import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import { result, fail, requireString, sha256 } from './support.mjs';
import { opAecMeasurement } from './real-ops.mjs';

const FAMILY = 'aec';
const FT_TO_M = 0.3048;

function digest(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Drawing measurement — real AEC measure dictionary path. */
export function aecSpacesRegions(ctx = {}) {
  const spaces = (Array.isArray(ctx.spaces) ? ctx.spaces : [{ id: 's1', name: 'Room 101', page: 1, areaM2: 12.5 }])
    .slice(0, 50)
    .map((s, i) => {
      const id = requireString(String(s.id ?? `s${i + 1}`), 'space.id', { min: 1, max: 40 });
      const name = requireString(String(s.name ?? id), 'space.name', { min: 1, max: 80 });
      const areaM2 = Number.isFinite(Number(s.areaM2)) ? Number(s.areaM2) : 0;
      if (areaM2 < 0) fail('INVALID_SPACE', 'areaM2 must be ≥ 0.', 400);
      return Object.freeze({ id, name, page: Number.isSafeInteger(s.page) ? s.page : 1, areaM2 });
    });
  const totalAreaM2 = spaces.reduce((a, s) => a + s.areaM2, 0);
  return result('aec.spaces-regions', {
    familyId: FAMILY,
    method: 'local-spaces-regions-takeoff',
    spaces,
    count: spaces.length,
    totalAreaM2,
    siValue: totalAreaM2,
    siUnit: 'm2',
  });
}

/** Drawing sets + revision log. */
export function aecSetsDrawingLog(ctx = {}) {
  const sets = (Array.isArray(ctx.sets) ? ctx.sets : [{ id: 'set-1', name: 'IFC', sheets: 3 }])
    .slice(0, 50)
    .map((s, i) => Object.freeze({
      id: String(s.id ?? `set-${i + 1}`),
      name: String(s.name ?? 'Set'),
      sheets: Number.isSafeInteger(s.sheets) ? s.sheets : 1,
    }));
  const log = (Array.isArray(ctx.log) ? ctx.log : [{ rev: 'A', date: '2026-07-01' }])
    .slice(0, 100)
    .map((entry) => Object.freeze({
      rev: String(entry.rev ?? 'A'),
      date: String(entry.date ?? '1970-01-01'),
    }));
  if (sets.length === 0) fail('EMPTY_SETS', 'At least one drawing set required.', 400);
  const sheetTotal = sets.reduce((n, s) => n + s.sheets, 0);
  return result('aec.sets-drawing-log', {
    familyId: FAMILY,
    method: 'local-drawing-set-log',
    sets,
    log,
    setCount: sets.length,
    logCount: log.length,
    sheetTotal,
    logDigest: digest(log.map((e) => `${e.rev}:${e.date}`)).slice(0, 32),
  });
}

/** Sheet metadata + tags. */
export function aecSheetMetadataTags(ctx = {}) {
  const number = requireString(String(ctx.number ?? 'A-101'), 'number', { min: 1, max: 40 });
  const title = requireString(String(ctx.title ?? 'Plan'), 'title', { min: 1, max: 120 });
  const tags = (Array.isArray(ctx.tags) ? ctx.tags : ['architectural'])
    .map((t) => requireString(String(t).toLowerCase(), 'tag', { min: 1, max: 40 }))
    .slice(0, 50);
  const uniqueTags = [...new Set(tags)];
  const sheet = Object.freeze({ number, title, tags: uniqueTags, tagCount: uniqueTags.length });
  const pdf = createTextPdf({
    text: `Sheet ${number}\n${title}\ntags: ${uniqueTags.join(', ')}`,
    title: `${number} ${title}`,
  });
  return result('aec.sheet-metadata-tags', {
    familyId: FAMILY,
    method: 'local-sheet-metadata-tags',
    sheet,
    pdf,
    outputSha256: sha256(pdf),
  });
}

/** Revision overlay compare plan. */
export function aecRevisionOverlay(ctx = {}) {
  const baseRev = requireString(String(ctx.baseRev ?? 'A'), 'baseRev', { min: 1, max: 20 });
  const compareRev = requireString(String(ctx.compareRev ?? 'B'), 'compareRev', { min: 1, max: 20 });
  if (baseRev === compareRev) fail('INVALID_OVERLAY', 'baseRev and compareRev must differ.', 400);
  const pages = Array.isArray(ctx.pages)
    ? ctx.pages.filter((p) => Number.isSafeInteger(p) && p > 0).slice(0, 200)
    : [1];
  if (pages.length === 0) fail('INVALID_OVERLAY', 'At least one page required.', 400);
  const overlay = Object.freeze({ baseRev, compareRev, pages, pageCount: pages.length });
  return result('aec.revision-overlay', {
    familyId: FAMILY,
    method: 'local-revision-overlay-plan',
    overlay,
    overlayDigest: digest([baseRev, compareRev, pages.join(',')]).slice(0, 32),
  });
}

/** Batch slip sheets for superseded pages. */
export function aecBatchSlipSheet(ctx = {}) {
  const slips = (Array.isArray(ctx.slips) ? ctx.slips : [{ page: 1, note: 'Superseded' }])
    .slice(0, 50)
    .map((s, i) => {
      const page = Number.isSafeInteger(s.page) ? s.page : i + 1;
      if (page < 1) fail('INVALID_SLIP', 'page must be ≥ 1.', 400);
      const note = requireString(String(s.note ?? 'Superseded'), 'slip.note', { min: 1, max: 200 });
      const markups = (Array.isArray(s.markups) ? s.markups : [])
        .slice(0, 50)
        .map((markup) => requireString(
          String(markup?.text ?? markup?.type ?? markup),
          'slip.markup',
          { min: 1, max: 200 },
        ));
      return Object.freeze({ page, note, markups: Object.freeze(markups) });
    });
  if (slips.length < 1 || new Set(slips.map((slip) => slip.page)).size !== slips.length) {
    fail('INVALID_SLIP', 'Slip-sheet source pages must be non-empty and unique.', 400);
  }
  const pages = slips.map((slip) => [
    'SLIP-SHEET',
    `SOURCE-PAGE:${slip.page}`,
    `NOTE:${slip.note}`,
    ...slip.markups.map((markup) => `CARRIED-MARKUP:${markup}`),
  ].join('\n'));
  const pdf = createTextPdf({ pages, title: 'AEC slip sheets' });
  const replacementPages = Object.freeze(slips.map((slip, index) => Object.freeze({
    outputPage: index + 1,
    sourcePage: slip.page,
    carriedMarkupCount: slip.markups.length,
  })));
  const carriedMarkupCount = slips.reduce((total, slip) => total + slip.markups.length, 0);
  return result('aec.batch-slip-sheet', {
    familyId: FAMILY,
    method: 'local-batch-slip-sheet-pdf',
    slips,
    count: slips.length,
    pageCount: pages.length,
    replacementPages,
    replacementSheetsCreated: true,
    carriedMarkupCount,
    pdf,
    outputSha256: sha256(pdf),
    bytes: pdf.length,
  });
}

/** Markup legend counts by type. */
export function aecLegends(ctx = {}) {
  const markups = Array.isArray(ctx.markups)
    ? ctx.markups
    : [{ type: 'cloud' }, { type: 'cloud' }, { type: 'arrow' }];
  if (markups.length === 0) fail('EMPTY_LEGEND', 'No markups to legend.', 400);
  const counts = Object.create(null);
  for (const m of markups.slice(0, 500)) {
    const type = String(m?.type ?? 'unknown');
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  const pdf = createTextPdf({
    text: `Legend\n${entries.map(([t, n]) => `${t}: ${n}`).join('\n')}`,
    title: 'AEC markup legend',
  });
  return result('aec.legends', {
    familyId: FAMILY,
    method: 'local-markup-legend-counts',
    counts: Object.freeze({ ...counts }),
    typeCount: entries.length,
    totalMarkups: markups.length,
    pdf,
    outputSha256: sha256(pdf),
  });
}

/** Revision status workflow transitions. */
export function aecRevisionStatusWorkflows(ctx = {}) {
  const from = requireString(ctx.from ?? 'draft', 'from', { min: 1, max: 40 });
  const to = requireString(ctx.to ?? 'issued', 'to', { min: 1, max: 40 });
  const allowedEdges = Object.freeze({
    draft: ['review', 'issued', 'void'],
    review: ['draft', 'issued', 'void'],
    issued: ['superseded', 'void'],
    superseded: ['void'],
    void: [],
  });
  const next = allowedEdges[from];
  const allowed = Array.isArray(next) ? next.includes(to) : from !== to;
  if (!allowed && ctx.strict === true) {
    fail('INVALID_TRANSITION', `Transition ${from}→${to} not allowed.`, 400);
  }
  return result('aec.revision-status-workflows', {
    familyId: FAMILY,
    method: 'local-revision-status-transition',
    transition: Object.freeze({ from, to }),
    allowed,
    allowedTargets: next ?? ['*'],
  });
}

/** Geospatial document calibration. */
export function aecGeospatialDocuments(ctx = {}) {
  const lon = Number(ctx.origin?.lon ?? ctx.lon ?? -122.4);
  const lat = Number(ctx.origin?.lat ?? ctx.lat ?? 37.8);
  const scale = Number(ctx.scale ?? 1);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    fail('INVALID_GEO', 'origin lon/lat must be finite numbers.', 400);
  }
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    fail('INVALID_GEO', 'lon/lat out of WGS84 bounds.', 400);
  }
  if (!(scale > 0) || scale > 1e9) fail('INVALID_GEO', 'scale must be positive.', 400);
  const calibration = Object.freeze({
    origin: Object.freeze({ lon, lat }),
    scale,
    crs: requireString(ctx.crs ?? 'EPSG:4326', 'crs', { min: 3, max: 32 }),
  });
  const calibrationId = digest([String(lon), String(lat), String(scale), calibration.crs]).slice(0, 24);
  return result('aec.geospatial-documents', {
    familyId: FAMILY,
    method: 'local-geospatial-calibration',
    calibration,
    calibrationId,
    bounds: Object.freeze({
      minLon: lon - 0.001 * scale,
      maxLon: lon + 0.001 * scale,
      minLat: lat - 0.001 * scale,
      maxLat: lat + 0.001 * scale,
    }),
  });
}
