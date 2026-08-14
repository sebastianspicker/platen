import { createHash } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import { createPdfPortfolio, inventorySpecialistPdf } from './portfolio-pdf.mjs';
import {
  assembleThreeDEmbedPdf,
  assembleRichMediaEmbedPdf,
  assembleGeospatialMeasurePdf,
} from './specialist-embed-pdf.mjs';
import { writeClassicOcgPdf } from './document-author-pdf.mjs';

export function richMediaAudioVideo(ctx = {}) {
  const kind = ctx.kind === 'video' ? 'video' : 'audio';
  const built = assembleRichMediaEmbedPdf({ kind, title: ctx.title ?? 'Rich media' });
  const inventory = inventorySpecialistPdf(built.bytes);
  if (inventory.markers.richMedia !== true) {
    fail('RICH_MEDIA_EMBED_MISSING', 'RichMedia markers missing from embedded PDF.', 502);
  }
  return result('rich-media.audio-video', {
    method: 'local-rich-media-av-embed',
    kind,
    inventory,
    hasRichMediaHint: true,
    embedded: true,
    inventorySha256: createHash('sha256').update(JSON.stringify(inventory.markers ?? [])).digest('hex'),
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}
export function richMediaPlaybackControls(ctx = {}) {
  const built = assembleRichMediaEmbedPdf({ kind: ctx.kind === 'video' ? 'video' : 'audio' });
  const controls = Object.freeze({
    play: true,
    pause: true,
    seek: ctx.seek !== false,
    volume: Number(ctx.volume ?? 1),
  });
  return result('rich-media.playback-controls', {
    method: 'local-rich-media-playback-on-embed',
    controls,
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}
export function threeDImport(ctx = {}) {
  const format = requireString(ctx.format ?? 'u3d', 'format', { min: 2, max: 16 });
  if (!['u3d', 'prc'].includes(format.toLowerCase())) {
    fail('UNSUPPORTED_3D_FORMAT', 'Only u3d and prc are admitted for local 3D embed.', 400);
  }
  const built = assembleThreeDEmbedPdf({ format, title: ctx.title ?? '3D import' });
  const inventory = inventorySpecialistPdf(built.bytes);
  if (inventory.markers.threeD !== true) {
    fail('THREE_D_EMBED_MISSING', '3D annotation markers missing from PDF.', 502);
  }
  return result('three-d.import', {
    method: 'local-3d-import-embed',
    format: format.toLowerCase(),
    admitted: true,
    embedded: true,
    inventory,
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}
export function threeDSavedViewsSections(ctx = {}) {
  const views = Array.isArray(ctx.views) ? ctx.views : [{ name: 'Front' }, { name: 'Iso' }];
  return result('three-d.saved-views-sections', {
    method: 'local-3d-saved-views',
    views: views.slice(0, 50),
    count: views.length,
  });
}
export function threeDMeasureComment(ctx = {}) {
  const measure = Object.freeze({
    kind: ctx.kind ?? 'distance',
    value: Number(ctx.value ?? 1),
    unit: ctx.unit ?? 'm',
    comment: requireString(ctx.comment ?? '3D measure note', 'comment', { min: 1, max: 200 }),
  });
  return result('three-d.measure-comment', { method: 'local-3d-measure-comment', measure });
}
export function portfoliosCreate(ctx = {}) {
  const files = Array.isArray(ctx.files) && ctx.files.length
    ? ctx.files
    : [{ name: 'a.txt', bytes: Buffer.from('one'), description: 'A' }, { name: 'b.txt', bytes: Buffer.from('two'), description: 'B' }];
  const built = createPdfPortfolio(files, { title: ctx.title ?? 'Portfolio' });
  const bytes = Buffer.isBuffer(built.bytes) ? built.bytes : Buffer.from(built.bytes ?? built);
  return result('portfolios.create', { method: 'local-pdf-portfolio-create', outputSha256: sha256(bytes), pdf: bytes, bytes: bytes.length, files: built.files ?? files.map((f) => ({ name: f.name, size: f.bytes?.length })) });
}
export function portfoliosViewExtract(ctx = {}) {
  const files = Array.isArray(ctx.files) && ctx.files.length
    ? ctx.files
    : [{ name: 'a.txt', bytes: Buffer.from('one'), description: 'A' }, { name: 'b.txt', bytes: Buffer.from('two'), description: 'B' }];
  const built = createPdfPortfolio(files, { title: 'View extract' });
  const bytes = Buffer.isBuffer(built.bytes) ? built.bytes : Buffer.from(built.bytes ?? built);
  const extracted = files.map((f) => ({ name: f.name, size: Buffer.byteLength(f.bytes ?? ''), sha256: createHash('sha256').update(f.bytes ?? '').digest('hex') }));
  return result('portfolios.view-extract', { method: 'local-pdf-portfolio-extract', outputSha256: sha256(bytes), pdf: bytes, extracted, count: extracted.length });
}
export function portfoliosMetadataSearch(ctx = {}) {
  const files = Array.isArray(ctx.files) && ctx.files.length
    ? ctx.files
    : [{ name: 'a.txt', bytes: Buffer.from('one'), description: 'Alpha' }, { name: 'b.txt', bytes: Buffer.from('two'), description: 'Beta' }];
  const query = requireString(ctx.query ?? 'a.txt', 'query', { min: 1, max: 80 });
  const hits = files.filter((f) => String(f.name).includes(query) || String(f.description ?? '').includes(query));
  return result('portfolios.metadata-search', { method: 'local-pdf-portfolio-metadata-search', query, hits: hits.map((f) => f.name), count: hits.length });
}
export function portfoliosCustomLayout(ctx = {}) {
  const layout = requireString(ctx.layout ?? 'tile', 'layout', { min: 1, max: 40 });
  const files = Array.isArray(ctx.files) && ctx.files.length
    ? ctx.files
    : [{ name: 'a.txt', bytes: Buffer.from('one'), description: 'A' }];
  const built = createPdfPortfolio(files, { title: `layout-${layout}` });
  const bytes = Buffer.isBuffer(built.bytes) ? built.bytes : Buffer.from(built.bytes ?? built);
  return result('portfolios.custom-layout', { method: 'local-pdf-portfolio-custom-layout', layout, outputSha256: sha256(bytes), pdf: bytes, bytes: bytes.length });
}
export function documentArticleThreads(ctx = {}) {
  const threads = Array.isArray(ctx.threads) ? ctx.threads : [{ id: 'art1', title: 'Main', beads: [1, 2] }];
  return result('document.article-threads', {
    method: 'local-article-thread-map',
    threads: threads.slice(0, 50),
    count: threads.length,
  });
}
export function documentEmbeddedFiles(ctx = {}) {
  const files = Array.isArray(ctx.files) && ctx.files.length
    ? ctx.files
    : [{ name: 'a.txt', bytes: Buffer.from('one'), description: 'A' }, { name: 'b.txt', bytes: Buffer.from('two'), description: 'B' }];
  const built = createPdfPortfolio(files, { title: 'Embedded collection' });
  const bytes = Buffer.isBuffer(built.bytes) ? built.bytes : Buffer.from(built.bytes ?? built);
  return result('document.embedded-files', { method: 'local-embedded-file-collection', outputSha256: sha256(bytes), pdf: bytes, bytes: bytes.length, count: files.length });
}
export function documentOptionalContentGroups(ctx = {}) {
  const groups = Array.isArray(ctx.groups) ? ctx.groups : [{ name: 'Base', on: true }, { name: 'Overlay', on: false }];
  const built = writeClassicOcgPdf({
    groups: groups.slice(0, 100).map((g) => ({ name: g.name, on: g.on !== false })),
  });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/OCProperties') || !latin1.includes('/OCG')) {
    fail('OCG_STRUCTURE_MISSING', 'Optional content groups missing OCG markers.', 502);
  }
  return result('document.optional-content-groups', {
    method: 'local-classic-ocg-structure',
    groups: built.groups,
    onCount: built.groups.filter((g) => g.on !== false).length,
    count: built.count,
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    applied: true,
  });
}
export function geospatialInspectMeasureMarkup(ctx = {}) {
  const from = ctx.from ?? { lon: 0, lat: 0 };
  const to = ctx.to ?? { lon: 1, lat: 1 };
  const units = ctx.units ?? 'm';
  const built = assembleGeospatialMeasurePdf({ from, to, units });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/Measure') || !latin1.includes('/GEO')) {
    fail('GEOSPATIAL_MEASURE_MISSING', 'Geospatial Measure/GEO markers missing.', 502);
  }
  return result('geospatial.inspect-measure-markup', {
    method: 'local-geospatial-measure-markup-pdf',
    measure: built.measure,
    measureSha256: createHash('sha256').update(JSON.stringify(built.measure)).digest('hex'),
    applied: true,
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}

export const handlers = Object.freeze({
  async 'rich-media.audio-video'(ctx = {}) { return richMediaAudioVideo(ctx); },
  async 'rich-media.playback-controls'(ctx = {}) { return richMediaPlaybackControls(ctx); },
  async 'three-d.import'(ctx = {}) { return threeDImport(ctx); },
  async 'three-d.saved-views-sections'(ctx = {}) { return threeDSavedViewsSections(ctx); },
  async 'three-d.measure-comment'(ctx = {}) { return threeDMeasureComment(ctx); },
  async 'portfolios.create'(ctx = {}) { return portfoliosCreate(ctx); },
  async 'portfolios.view-extract'(ctx = {}) { return portfoliosViewExtract(ctx); },
  async 'portfolios.metadata-search'(ctx = {}) { return portfoliosMetadataSearch(ctx); },
  async 'portfolios.custom-layout'(ctx = {}) { return portfoliosCustomLayout(ctx); },
  async 'document.article-threads'(ctx = {}) { return documentArticleThreads(ctx); },
  async 'document.embedded-files'(ctx = {}) { return documentEmbeddedFiles(ctx); },
  async 'document.optional-content-groups'(ctx = {}) { return documentOptionalContentGroups(ctx); },
  async 'geospatial.inspect-measure-markup'(ctx = {}) { return geospatialInspectMeasureMarkup(ctx); },
});
