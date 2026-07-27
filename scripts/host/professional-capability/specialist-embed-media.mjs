/**
 * 3D, rich-media, geospatial, and CAD/BIM specialist PDF builders.
 */
import { createHash } from 'node:crypto';
import {
  pdfLiteral,
  finalizeSpecialistPdf,
  allocIds,
} from './specialist-embed-core.mjs';

/** Embed a minimal U3D/PRC 3D annotation + stream. */
export function assembleThreeDEmbedPdf({ format = 'u3d', title = '3D import' } = {}) {
  const fmt = String(format).toLowerCase() === 'prc' ? 'PRC' : 'U3D';
  const modelPayload = Buffer.from(`PLATEN-3D-${fmt}-MODEL-v1\0`, 'latin1');
  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const stream3dId = alloc();
  const annotId = alloc();
  const viewId = alloc();

  const content = `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`3D ${fmt} embed`)} Tj ET\n`;
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(stream3dId, `<< /Type /3D /Subtype /${fmt} /Filter /ASCIIHexDecode /Length ${modelPayload.length * 2 + 1} >>\nstream\n${modelPayload.toString('hex')}>\nendstream`);
  objects.set(viewId, `<< /Type /3DView /XN ${pdfLiteral('Default')} /MS /M /C2W [1 0 0 0 1 0 0 0 1 0 0 5] /CO 5 >>`);
  objects.set(annotId, `<< /Type /Annot /Subtype /3D /Rect [72 400 540 700] /3DD ${stream3dId} 0 R /3DV ${viewId} 0 R /3DI true /F 4 /Contents ${pdfLiteral('3D model')} /P ${pageId} 0 R >>`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /Annots [${annotId} 0 R] >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    format: fmt.toLowerCase(),
    title,
  });
}

/** Embed a RichMedia annotation with a minimal media stream. */
export function assembleRichMediaEmbedPdf({ kind = 'audio', title = 'Rich media' } = {}) {
  const mediaKind = kind === 'video' ? 'video' : 'audio';
  const payload = Buffer.from(`PLATEN-RICHMEDIA-${mediaKind}-v1\0`, 'latin1');
  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const mediaStreamId = alloc();
  const filespecId = alloc();
  const contentRmId = alloc();
  const settingsId = alloc();
  const annotId = alloc();

  const content = `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`RichMedia ${mediaKind}`)} Tj ET\n`;
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(mediaStreamId, `<< /Type /EmbeddedFile /Subtype ${mediaKind === 'audio' ? '/audio#2Fmpeg' : '/video#2Fmp4'} /Length ${payload.length} >>\nstream\n${payload.toString('latin1')}\nendstream`);
  objects.set(filespecId, `<< /Type /Filespec /F ${pdfLiteral(mediaKind === 'audio' ? 'clip.mp3' : 'clip.mp4')} /EF << /F ${mediaStreamId} 0 R >> >>`);
  objects.set(contentRmId, `<< /Type /RichMediaContent /Assets << /Names [${pdfLiteral(mediaKind)} ${filespecId} 0 R] >> /Configurations [] >>`);
  objects.set(settingsId, `<< /Type /RichMediaSettings /Activation << /Condition /PO >> /Deactivation << /Condition /PC >> >>`);
  objects.set(annotId, `<< /Type /Annot /Subtype /RichMedia /Rect [72 500 320 640] /RichMediaContent ${contentRmId} 0 R /RichMediaSettings ${settingsId} 0 R /F 4 /Contents ${pdfLiteral('RichMedia')} /P ${pageId} 0 R /Sound ${filespecId} 0 R >>`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /Annots [${annotId} 0 R] >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    kind: mediaKind,
    title,
  });
}

/** Geospatial measure dictionary on page (PDF geospatial extension subset). */
export function assembleGeospatialMeasurePdf({
  from = { lon: 0, lat: 0 },
  to = { lon: 1, lat: 1 },
  units = 'm',
} = {}) {
  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const gcsId = alloc();
  const measureId = alloc();

  const content = [
    '0.2 w 72 400 m 540 600 l S',
    `BT /F1 11 Tf 72 720 Td ${pdfLiteral(`GEO measure ${from.lon},${from.lat} → ${to.lon},${to.lat} ${units}`)} Tj ET\n`,
  ].join('\n');

  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(gcsId, '<< /Type /GEOGCS /EPSG 4326 /Name (WGS 84) >>');
  objects.set(measureId, `<< /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] /GCS ${gcsId} 0 R /PDU [/${units === 'm' ? 'M' : 'FT'} /SQM /DEG] /GPTS [${Number(from.lat)} ${Number(from.lon)} ${Number(from.lat)} ${Number(to.lon)} ${Number(to.lat)} ${Number(to.lon)} ${Number(to.lat)} ${Number(from.lon)}] /LPTS [0 0 0 1 1 1 1 0] >>`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /VP [ << /Type /Viewport /BBox [72 400 540 600] /Measure ${measureId} 0 R >> ] /Measure ${measureId} 0 R >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    measure: Object.freeze({
      kind: 'geodesic-distance',
      from: Object.freeze({ ...from }),
      to: Object.freeze({ ...to }),
      units,
    }),
  });
}

/** CAD/BIM entity drawing export — lines as path content + entity digest marker. */
export function assembleCadBimPdf({ entities = [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }] } = {}) {
  const list = (Array.isArray(entities) && entities.length ? entities : [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }]).slice(0, 500);
  const pathOps = [];
  for (const entity of list) {
    const type = String(entity?.type ?? 'line');
    if (type === 'line') {
      const x1 = 72 + Number(entity.x1 ?? 0) * 200;
      const y1 = 400 + Number(entity.y1 ?? 0) * 200;
      const x2 = 72 + Number(entity.x2 ?? 1) * 200;
      const y2 = 400 + Number(entity.y2 ?? 1) * 200;
      pathOps.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    } else {
      pathOps.push('72 400 40 40 re S');
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16);
  const content = [
    '0.5 w',
    ...pathOps,
    `BT /F1 10 Tf 72 720 Td ${pdfLiteral(`CAD/BIM entities n=${list.length} id=${digest}`)} Tj`,
    '0 -14 Td (CAD_BIM_EXPORT) Tj ET\n',
  ].join('\n');

  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();

  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /PieceInfo << /CadBim << /LastModified (D:20200101000000Z) /Private << /EntityCount ${list.length} /Digest ${pdfLiteral(digest)} >> >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const byType = Object.create(null);
  for (const entity of list) {
    const type = String(entity?.type ?? 'unknown');
    byType[type] = (byType[type] ?? 0) + 1;
  }

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    entities: list,
    count: list.length,
    byType: Object.freeze(byType),
    digest,
  });
}
