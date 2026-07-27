/**
 * Barcode decoration, AcroForm barcode fields, output intents, spot colors.
 */
import { createHash } from 'node:crypto';
import {
  pdfLiteral,
  pdfEscapeName,
  finalizeSpecialistPdf,
  allocIds,
} from './specialist-embed-core.mjs';

/** Simple Code128-style module bars from character codes (deterministic, not full ISO). */
function barcodeBarModules(value) {
  const modules = [];
  modules.push(2, 1, 1, 2, 1, 1);
  for (const ch of String(value)) {
    const c = ch.charCodeAt(0) % 103;
    modules.push(
      1 + (c % 3),
      1 + ((c >> 2) % 3),
      1 + ((c >> 4) % 3),
      1 + (c % 2),
      1 + ((c >> 3) % 3),
      1 + ((c >> 1) % 2),
    );
  }
  modules.push(2, 3, 3, 1, 1, 1, 2);
  return modules;
}

/**
 * PDF with drawn barcode bars, production-mark labels, and barcode metadata.
 */
export function assembleBarcodeDecorationPdf({ value, symbology = 'code128', title = 'Barcode decoration' } = {}) {
  const v = String(value ?? '123456789012').slice(0, 64);
  const sym = String(symbology ?? 'code128').slice(0, 32);
  const barcodeId = createHash('sha256').update(`${sym}|${v}`).digest('hex').slice(0, 16);
  const modules = barcodeBarModules(v);
  const barH = 48;
  const barY = 680;
  let x = 72;
  const unit = 1.2;
  const pathOps = [];
  let isBar = true;
  for (const w of modules) {
    const width = w * unit;
    if (isBar) pathOps.push(`${x.toFixed(2)} ${barY} ${width.toFixed(2)} ${barH} re f`);
    x += width;
    isBar = !isBar;
  }
  const content = [
    'q 0 0 0 rg',
    ...pathOps,
    'Q',
    'BT /F1 10 Tf 72 650 Td',
    `${pdfLiteral(`${sym}:${v}`)} Tj`,
    '0 -14 Td',
    `${pdfLiteral(`BARCODE_ID:${barcodeId}`)} Tj`,
    '0 -14 Td (CUT_CONTOUR) Tj',
    '0 -14 Td (VARNISH_MARK) Tj',
    '0 -14 Td (WHITE_INK_MARK) Tj ET\n',
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
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /PieceInfo << /Barcode << /LastModified (D:20200101000000Z) /Private << /Symbology ${pdfLiteral(sym)} /Value ${pdfLiteral(v)} /BarcodeId ${pdfLiteral(barcodeId)} >> >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    barcodeId,
    value: v,
    symbology: sym,
    title,
  });
}

/** AcroForm text field carrying barcode value + barcode decoration content. */
export function assembleBarcodeFieldPdf({ value, fieldName = 'Barcode.Field' } = {}) {
  const v = String(value ?? 'WB-001').slice(0, 64);
  const name = String(fieldName).slice(0, 64);
  const deco = assembleBarcodeDecorationPdf({ value: v, symbology: 'code128', title: 'Barcode field' });
  const modules = barcodeBarModules(v);
  let x = 72;
  const unit = 1.2;
  const pathOps = [];
  let isBar = true;
  for (const w of modules) {
    const width = w * unit;
    if (isBar) pathOps.push(`${x.toFixed(2)} 700 ${width.toFixed(2)} 36 re f`);
    x += width;
    isBar = !isBar;
  }
  const content = [
    'q 0 0 0 rg',
    ...pathOps,
    'Q',
    `BT /F1 11 Tf 72 670 Td ${pdfLiteral(`Barcode field ${v}`)} Tj ET\n`,
  ].join('\n');

  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const fieldId = alloc();
  const acroId = alloc();

  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(fieldId, `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${pdfLiteral(name)} /V ${pdfLiteral(v)} /Rect [72 620 320 650] /F 4 /P ${pageId} 0 R /DA (/Helv 10 Tf 0 g) >>`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /Annots [${fieldId} 0 R] >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(acroId, `<< /Fields [${fieldId} 0 R] /DR << /Font << /Helv ${fontId} 0 R >> >> /DA (/Helv 10 Tf 0 g) >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm ${acroId} 0 R >>`);

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    value: v,
    fieldName: name,
    barcodeId: deco.barcodeId,
  });
}

/** PDF/X-style OutputIntent assignment (structural, not ICC-certified). */
export function assembleOutputIntentPdf({ intent = 'FOGRA39' } = {}) {
  const name = String(intent).slice(0, 80);
  const icc = Buffer.from(`ICC-PROFILE-PLACEHOLDER-${name}`, 'latin1');
  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const destId = alloc();
  const intentId = alloc();

  const content = `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`OutputIntent ${name}`)} Tj ET\n`;
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(destId, `<< /N 3 /Length ${icc.length} >>\nstream\n${icc.toString('latin1')}\nendstream`);
  objects.set(intentId, `<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier ${pdfLiteral(name)} /Info ${pdfLiteral(name)} /RegistryName ${pdfLiteral('http://www.color.org')} /DestOutputProfile ${destId} 0 R >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /OutputIntents [${intentId} 0 R] >>`);

  return Object.freeze({ bytes: finalizeSpecialistPdf(objects, catalogId, nextId), intent: name });
}

/** Spot color via Separation colorspace on page resources. */
export function assembleSpotColorPdf({ spots = [{ name: 'PANTONE 185 C', cmyk: [0, 0.91, 0.76, 0] }] } = {}) {
  const list = (Array.isArray(spots) && spots.length ? spots : [{ name: 'PANTONE 185 C', cmyk: [0, 0.91, 0.76, 0] }]).slice(0, 16);
  const objects = new Map();
  const { alloc, nextId } = allocIds();
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();

  const csEntries = [];
  const pathOps = [];
  list.forEach((spot, i) => {
    const spotName = String(spot.name ?? `Spot${i + 1}`).slice(0, 64);
    const cmyk = Array.isArray(spot.cmyk) ? spot.cmyk.map(Number) : [0, 1, 1, 0];
    const [c, m, y, k] = cmyk.map((n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0));
    const csKey = `CS${i + 1}`;
    csEntries.push(`${pdfEscapeName(csKey)} [ /Separation ${pdfEscapeName(spotName.replace(/\s+/g, '#20'))} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [${c} ${m} ${y} ${k}] /N 1 >> ]`);
    const x = 72 + i * 80;
    pathOps.push(`/${csKey} cs 1 scn ${x} 700 60 40 re f`);
  });

  const content = [
    ...pathOps,
    '0 0 0 rg',
    `BT /F1 11 Tf 72 660 Td ${pdfLiteral(`Spot colors: ${list.map((s) => s.name).join(', ')}`)} Tj ET\n`,
  ].join('\n');

  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /ColorSpace << ${csEntries.join(' ')} >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  return Object.freeze({
    bytes: finalizeSpecialistPdf(objects, catalogId, nextId),
    spots: list.map((s) => ({ name: String(s.name), cmyk: s.cmyk })),
    count: list.length,
  });
}

// Re-export media builders so existing single-module imports keep working.
export {
  assembleThreeDEmbedPdf,
  assembleRichMediaEmbedPdf,
  assembleGeospatialMeasurePdf,
  assembleCadBimPdf,
} from './specialist-embed-media.mjs';
