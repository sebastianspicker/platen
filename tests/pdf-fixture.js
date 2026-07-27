function escapePdfString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function assertRectangles(boxes, pageCount, label) {
  if (!Array.isArray(boxes) || boxes.length > pageCount
    || boxes.some((box) => !Array.isArray(box) || box.length !== 4
      || box.some((coordinate) => !Number.isFinite(coordinate))
      || box[2] <= box[0] || box[3] <= box[1])) {
    throw new TypeError(`${label} must contain valid page rectangles`);
  }
}

function validateOptions(texts, options) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new TypeError('texts must contain at least one page string');
  }
  if (typeof options.tagged !== 'boolean') throw new TypeError('tagged must be a boolean');
  const actions = new Set(['goTo', 'uri', 'remoteGoTo', 'named', 'javascript']);
  if (!Array.isArray(options.outlines) || options.outlines.some((outline) => {
    const pageValid = outline?.page === null
      || (Number.isSafeInteger(outline?.page) && outline.page >= 1 && outline.page <= texts.length);
    const actionValid = outline?.action === undefined || actions.has(outline.action);
    const directValid = outline?.directDestination === undefined
      || typeof outline.directDestination === 'boolean';
    const needsPage = outline?.action === 'goTo' || outline?.directDestination === true;
    return !outline || typeof outline.title !== 'string' || !pageValid || !actionValid
      || !directValid || (needsPage && outline.page === null);
  })) {
    throw new TypeError(
      'outlines must contain valid titles and local page numbers or an unresolved null target',
    );
  }
  if (!Array.isArray(options.rotations) || options.rotations.length > texts.length
    || options.rotations.some((rotation) => ![0, 90, 180, 270].includes(rotation))) {
    throw new TypeError('rotations must contain supported page rotations');
  }
  assertRectangles(options.cropBoxes, texts.length, 'cropBoxes');
  assertRectangles(options.bleedBoxes, texts.length, 'bleedBoxes');
  assertRectangles(options.trimBoxes, texts.length, 'trimBoxes');
}

function appendPages(objects, texts, options) {
  const pageReferences = [];
  const pageObjectNumbers = [];
  for (const [pageIndex, text] of texts.entries()) {
    const textContent = `BT\n/F1 18 Tf\n72 720 Td\n(${escapePdfString(text)}) Tj\nET\n`;
    const content = options.tagged ? `/P <</MCID 0>> BDC\n${textContent}EMC\n` : textContent;
    const pageReference = objects.length + 1;
    const contentReference = pageReference + 1;
    pageReferences.push(`${pageReference} 0 R`);
    pageObjectNumbers.push(pageReference);
    const boxes = [
      options.cropBoxes[pageIndex] ? ` /CropBox [${options.cropBoxes[pageIndex].join(' ')}]` : '',
      options.bleedBoxes[pageIndex] ? ` /BleedBox [${options.bleedBoxes[pageIndex].join(' ')}]` : '',
      options.trimBoxes[pageIndex] ? ` /TrimBox [${options.trimBoxes[pageIndex].join(' ')}]` : '',
    ].join('');
    const rotation = options.rotations[pageIndex] ? ` /Rotate ${options.rotations[pageIndex]}` : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${boxes}${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentReference} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }
  return { pageObjectNumbers, pageReferences };
}

function outlineAction(outline, pageObjectNumbers) {
  if (outline.action === 'goTo') {
    return ` /A << /S /GoTo /D [${pageObjectNumbers[outline.page - 1]} 0 R /Fit] >>`;
  }
  if (outline.action === 'uri') return ' /A << /S /URI /URI (https://example.invalid) >>';
  if (outline.action === 'remoteGoTo') return ' /A << /S /GoToR /F (remote.pdf) /D [0 /Fit] >>';
  if (outline.action === 'named') return ' /A << /S /Named /N /NextPage >>';
  if (outline.action === 'javascript') return ' /A << /S /JavaScript /JS (noop) >>';
  return '';
}

function appendOutlines(objects, outlines, pageObjectNumbers) {
  if (!outlines.length) return null;
  const rootReference = objects.length + 1;
  const itemReferences = outlines.map((_, index) => rootReference + index + 1);
  objects.push(
    `<< /Type /Outlines /First ${itemReferences[0]} 0 R /Last ${itemReferences.at(-1)} 0 R /Count ${itemReferences.length} >>`,
  );
  outlines.forEach((outline, index) => {
    const links = [
      index > 0 ? `/Prev ${itemReferences[index - 1]} 0 R` : '',
      index < itemReferences.length - 1 ? `/Next ${itemReferences[index + 1]} 0 R` : '',
    ].filter(Boolean).join(' ');
    const directDestination = outline.directDestination ?? outline.action === undefined;
    const destination = directDestination && outline.page !== null
      ? ` /Dest [${pageObjectNumbers[outline.page - 1]} 0 R /Fit]` : '';
    objects.push(
      `<< /Title (${escapePdfString(outline.title)}) /Parent ${rootReference} 0 R ${links}${destination}${outlineAction(outline, pageObjectNumbers)} >>`,
    );
  });
  return rootReference;
}

function appendAttachment(objects, attachment) {
  if (!attachment) return null;
  const safeName = escapePdfString(attachment.name ?? 'note.txt');
  const bytes = Buffer.from(attachment.content ?? 'local attachment', 'utf8');
  const namesReference = objects.length + 1;
  const fileSpecReference = namesReference + 1;
  const streamReference = namesReference + 2;
  objects.push(
    `<< /Names [(${safeName}) ${fileSpecReference} 0 R] >>`,
    `<< /Type /Filespec /F (${safeName}) /UF (${safeName}) /EF << /F ${streamReference} 0 R >> >>`,
    `<< /Type /EmbeddedFile /Length ${bytes.length} >>\nstream\n${bytes.toString('binary')}\nendstream`,
  );
  return namesReference;
}

function appendStructure(objects, texts, pageObjectNumbers) {
  const rootReference = objects.length + 1;
  const documentReference = rootReference + 1;
  const elementReferences = texts.map((_text, index) => rootReference + index + 2);
  const parentTreeReference = rootReference + texts.length + 2;
  objects.push(
    `<< /Type /StructTreeRoot /K ${documentReference} 0 R /ParentTree ${parentTreeReference} 0 R /ParentTreeNextKey ${texts.length} >>`,
    `<< /Type /StructElem /S /Document /P ${rootReference} 0 R /K [${elementReferences.map((reference) => `${reference} 0 R`).join(' ')}] >>`,
  );
  texts.forEach((_text, index) => {
    objects.push(
      `<< /Type /StructElem /S /P /P ${documentReference} 0 R /Pg ${pageObjectNumbers[index]} 0 R /K 0 >>`,
    );
    objects[pageObjectNumbers[index] - 1] = objects[pageObjectNumbers[index] - 1]
      .replace('/MediaBox', `/StructParents ${index} /MediaBox`);
  });
  objects.push(
    `<< /Nums [${elementReferences.map((reference, index) => `${index} [${reference} 0 R]`).join(' ')}] >>`,
  );
  return rootReference;
}

function serializePdf(objects) {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

export function makeMultiPagePdf(texts, {
  attachment = null,
  outlines = [],
  rotations = [],
  cropBoxes = [],
  bleedBoxes = [],
  trimBoxes = [],
  tagged = false,
} = {}) {
  const options = { attachment, outlines, rotations, cropBoxes, bleedBoxes, trimBoxes, tagged };
  validateOptions(texts, options);
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const { pageObjectNumbers, pageReferences } = appendPages(objects, texts, options);
  const outlinesReference = appendOutlines(objects, outlines, pageObjectNumbers);
  const embeddedFilesReference = appendAttachment(objects, attachment);
  const structureRootReference = tagged
    ? appendStructure(objects, texts, pageObjectNumbers) : null;
  const catalogEntries = ['/Type /Catalog', '/Pages 2 0 R'];
  if (embeddedFilesReference) {
    catalogEntries.push(`/Names << /EmbeddedFiles ${embeddedFilesReference} 0 R >>`);
  }
  if (outlinesReference) catalogEntries.push(`/Outlines ${outlinesReference} 0 R`);
  if (structureRootReference) {
    catalogEntries.push(`/StructTreeRoot ${structureRootReference} 0 R`);
    catalogEntries.push('/MarkInfo << /Marked true >>', '/Lang (en-US)');
  }
  if (outlinesReference) catalogEntries.push('/PageMode /UseOutlines');
  else if (embeddedFilesReference) catalogEntries.push('/PageMode /UseAttachments');
  objects[0] = `<< ${catalogEntries.join(' ')} >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pageReferences.length} >>`;
  return serializePdf(objects);
}

export function makeTextPdf(text = 'Platen local search', options = {}) {
  return makeMultiPagePdf([text], options);
}
