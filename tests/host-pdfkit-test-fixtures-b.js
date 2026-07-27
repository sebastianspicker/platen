function makeButtonWidgetPdf() {
  const stream = 'BT\n/Helv 18 Tf\n72 720 Td\n(button control fixture) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 9 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R 8 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (checkbox-control) /V /private-checkbox-state-token /AS /private-checkbox-state-token /Rect [72 650 300 680] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (radio-control) /Ff 32768 /V /private-radio-state-token /AS /private-radio-state-token /Rect [72 610 300 640] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (push-control) /Ff 65536 /V /private-push-state-token /AS /private-push-state-token /Rect [72 570 300 600] /P 3 0 R >>',
    '<< /Fields [6 0 R 7 0 R 8 0 R] /NeedAppearances true /DR << /Font << /Helv 4 0 R >> >> >>',
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function makeCustomCheckboxPdf({
  fieldName = 'consent-checkbox', onName = 'CheckedCustom', initialState = 'Off', flags = 0,
  withAction = false, includeOff = true, includeOn = true, catalogExtra = '', pageExtra = '', acroFormExtra = '', sharedFieldName = false,
  hiddenSignature = false, inheritedParentFlags = null, orphanField = false, duplicateFieldReference = false,
} = {}) {
  const pageStream = 'BT\n/Helv 18 Tf\n72 720 Td\n(custom checkbox fixture) Tj\nET\n';
  const offAppearance = 'q\n1 1 1 rg\n0 0 228 30 re\nf\nQ\n';
  const onAppearance = 'q\n0 0 0 rg\n0 0 228 30 re\nf\nQ\n';
  const hasParent = inheritedParentFlags !== null;
  const acroFormObject = sharedFieldName || hasParent ? 8 : 7;
  const offObject = acroFormObject + 1;
  const onObject = acroFormObject + 2;
  const hiddenSignatureObject = acroFormObject + 3;
  const rootFieldReferences = hasParent ? '7 0 R' : `6 0 R${sharedFieldName ? ' 7 0 R' : ''}`;
  const fieldReferences = `${orphanField ? '' : rootFieldReferences}${duplicateFieldReference ? ` ${hasParent ? '7' : '6'} 0 R` : ''}${hiddenSignature ? ` ${hiddenSignatureObject} 0 R` : ''}`.trim();
  const states = [includeOff ? `/Off ${offObject} 0 R` : '', includeOn ? `/${onName} ${onObject} 0 R` : ''].filter(Boolean).join(' ');
  const widget = hasParent
    ? `<< /Type /Annot /Subtype /Widget /V /${initialState} /AS /${initialState} /Rect [72 650 300 680] /P 3 0 R /Parent 7 0 R${withAction ? ' /A << /S /URI /URI (https://example.invalid) >>' : ''} /AP << /N << ${states} >> >> >>`
    : `<< /Type /Annot /Subtype /Widget /FT /Btn /T (${fieldName}) /V /${initialState} /AS /${initialState} /Rect [72 650 300 680] /P 3 0 R${flags ? ` /Ff ${flags}` : ''}${withAction ? ' /A << /S /URI /URI (https://example.invalid) >>' : ''} /AP << /N << ${states} >> >> >>`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm ${acroFormObject} 0 R${catalogExtra} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R${sharedFieldName ? ' 7 0 R' : ''}]${pageExtra} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(pageStream)} >>\nstream\n${pageStream}endstream`,
    widget,
    ...(sharedFieldName ? [widget.replace('[72 650 300 680]', '[320 650 548 680]')]
      : hasParent ? [`<< /FT /Btn /T (${fieldName}) /V /${initialState} /Ff ${inheritedParentFlags} /Kids [6 0 R] >>`] : []),
    `<< /Fields [${fieldReferences}] /NeedAppearances false /DR << /Font << /Helv 4 0 R >> >>${acroFormExtra} >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 228 30] /Length ${Buffer.byteLength(offAppearance)} >>\nstream\n${offAppearance}endstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 228 30] /Length ${Buffer.byteLength(onAppearance)} >>\nstream\n${onAppearance}endstream`,
    ...(hiddenSignature ? ['<< /FT /Sig /T (non-page signature field) >>'] : []),
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function makeCanonicalRadioPdf({
  selectedIndex = 1, targetPages = [1, 1, 2], flags = 0, withAction = false, duplicateKid = false,
} = {}) {
  const first = 'BT\n/Helv 18 Tf\n72 720 Td\n(radio page one) Tj\nET\n';
  const second = 'BT\n/Helv 18 Tf\n72 720 Td\n(radio page two) Tj\nET\n';
  const states = ['private-radio-alpha', 'private-radio-bravo', 'private-radio-charlie'];
  const pageWidgets = [1, 2].map((page) => states
    .map((_, index) => targetPages[index] === page ? `${8 + index} 0 R` : null).filter(Boolean).join(' '));
  const widgets = states.map((state, index) => {
    const current = selectedIndex === index ? state : 'Off';
    const page = targetPages[index] + 2;
    return `<< /Type /Annot /Subtype /Widget /Parent 12 0 R /P ${page} 0 R /AS /${current} /Rect [${72 + index * 120} 650 ${180 + index * 120} 680]${withAction && index === 0 ? ' /A << /S /URI /URI (https://example.invalid) >>' : ''} /AP << /N << /Off ${13 + index * 2} 0 R /${state} ${14 + index * 2} 0 R >> >> >>`;
  });
  const value = selectedIndex === null ? 'Off' : states[selectedIndex];
  const kids = duplicateKid ? '8 0 R 8 0 R 10 0 R' : '8 0 R 9 0 R 10 0 R';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 11 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 5 0 R >> >> /Contents 6 0 R /Annots [${pageWidgets[0]}] >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 5 0 R >> >> /Contents 7 0 R /Annots [${pageWidgets[1]}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
    ...widgets,
    '<< /Fields [12 0 R] /NeedAppearances false >>',
    `<< /FT /Btn /T (private-radio-group-name) /Ff ${32768 | flags} /V /${value} /Kids [${kids}] >>`,
    ...states.flatMap((_, index) => [
      '<< /Type /XObject /Subtype /Form /BBox [0 0 108 30] /Length 0 >>\nstream\nendstream',
      '<< /Type /XObject /Subtype /Form /BBox [0 0 108 30] /Length 25 >>\nstream\n0 0 0 rg 0 0 108 30 re f\nendstream',
    ]),
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function pdfUtf16TextToken(value) {
  const bytes = Buffer.from(String(value), 'utf16le');
  for (let index = 0; index < bytes.length; index += 2) {
    [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
  }
  return `<FEFF${bytes.toString('hex').toUpperCase()}>`;
}

function makeNavigationPdf({ frontPrefix = 'Front-', bodyPrefix = 'Body-' } = {}) {
  const first = '/OC /Layer BDC\nBT\n/F1 18 Tf\n72 720 Td\n(Front matter) Tj\nET\nEMC\n';
  const second = 'BT\n/F1 18 Tf\n72 720 Td\n(Body page) Tj\nET\n';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /P ${pdfUtf16TextToken(frontPrefix)} /S /r /St 1 >> 1 << /P ${pdfUtf16TextToken(bodyPrefix)} /S /D /St 3 >>] >> /OCProperties << /OCGs [10 0 R] /D << /Name (Default) /BaseState /ON /ON [10 0 R] /Order [10 0 R] >> >> >>`,
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /Properties << /Layer 10 0 R >> >> /Contents 6 0 R /Annots [7 0 R 8 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    '<< /Type /Annot /Subtype /Link /Rect [72 680 260 710] /Dest [4 0 R /Fit] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Link /Rect [72 640 260 670] /A << /S /URI /URI (https://example.test/inert) >> /P 3 0 R >>',
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
    '<< /Type /OCG /Name (Review layer) /Intent /View >>',
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function makeLocalGoToAnnotationFixture({ annotation, extraObjects = [], pageExtra = '', annotationReferences = '8 0 R' }) {
  const first = 'BT\n/F1 18 Tf\n72 720 Td\n(Source page) Tj\nET\n';
  const second = 'BT\n/F1 18 Tf\n72 720 Td\n(Target page) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [${annotationReferences}]${pageExtra} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
    annotation,
    ...extraObjects,
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

export { makeButtonWidgetPdf, makeCustomCheckboxPdf, makeCanonicalRadioPdf, pdfUtf16TextToken, makeNavigationPdf, makeLocalGoToAnnotationFixture };
