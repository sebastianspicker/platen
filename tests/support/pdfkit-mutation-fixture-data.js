import { createHash } from 'node:crypto';

export const documentId = '11111111-1111-4111-8111-111111111111';
export const sourceBytes = Buffer.from('%PDF-1.7\nstructure fixture\n%%EOF');
export const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
function closedClassicOutput() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n',
  ];
  let body = '%PDF-1.7\n%\xFF\xFF\xFF\xFF\n'; const offsets = [];
  for (const object of objects) { offsets.push(Buffer.byteLength(body, 'latin1')); body += object; }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
export const nativeOutput = closedClassicOutput();
export const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function page(index) {
  const rect = { x: 0, y: 0, width: 612, height: 792 };
  return {
    index,
    rotation: 0,
    boxes: { media: rect, crop: rect, bleed: rect, trim: rect, art: rect },
    annotations: [],
    annotationsTruncated: false,
    widgets: [],
    widgetsTruncated: false,
  };
}

export function inspection(pageCount = 2) {
  return {
    document: {
      pageCount,
      encrypted: false,
      locked: false,
      permissions: {},
      supportedAnnotationTypes: [],
    },
    metadata: {
      title: 'Edited',
      author: null,
      subject: null,
      creator: null,
      producer: null,
      creationDate: null,
      modificationDate: null,
      keywords: null,
    },
    pages: Array.from({ length: pageCount }, (_, index) => page(index + 1)),
    pagesTruncated: false,
    outline: { items: [], truncated: false },
  };
}

export function inspectedPageOutput(pageNumber, {
  rotation = 0,
  crop = { x: 0, y: 0, width: 612, height: 792 },
  bleed = { x: 0, y: 0, width: 612, height: 792 },
  trim = { x: 20, y: 20, width: 572, height: 752 },
  art = { x: 20, y: 20, width: 572, height: 752 },
} = {}) {
  const boxLine = (label, rect) => `Page ${pageNumber} ${label}: ${rect.x} ${rect.y} ${rect.x + rect.width} ${rect.y + rect.height}`;
  return [
    `Page ${pageNumber} size: 612 x 792 pts`,
    `Page ${pageNumber} rot: ${rotation}`,
    `Page ${pageNumber} MediaBox: 0 0 612 792`,
    boxLine('CropBox', crop),
    boxLine('BleedBox', bleed),
    boxLine('TrimBox', trim),
    boxLine('ArtBox', art),
    '',
  ].join('\n');
}

export function mutation(overrides = {}) {
  return {
    metadata: { title: 'Edited', author: null, subject: null, keywords: null },
    pageBox: null,
    rotation: null,
    annotations: [],
    ...overrides,
  };
}

export const mutationOptions = (signal) => ({
  sourceSha256: sourceDigest,
  ...(signal ? { signal } : {}),
});

export function outputDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
