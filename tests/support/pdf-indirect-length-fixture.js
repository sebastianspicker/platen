function assemble(objects) {
  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = new Map();
  for (const [number, value] of objects) {
    offsets.set(number, Buffer.byteLength(body, 'latin1'));
    body += `${number} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  const maximum = Math.max(...objects.keys());
  body += `xref\n0 ${maximum + 1}\n0000000000 65535 f \n`;
  for (let number = 1; number <= maximum; number += 1) {
    const offset = offsets.get(number);
    body += offset === undefined
      ? '0000000000 00000 f \n'
      : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${maximum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function makeIndirectLengthPdf({
  lengthReference = '5 0 R',
  lengthValue = 4,
  includeLengthObject = true,
  lengthObject = 5,
} = {}) {
  const content = 'q\nQ\n';
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>'],
    [4, `<< /Length ${lengthReference} >>\nstream\n${content}endstream`],
  ]);
  if (includeLengthObject) objects.set(lengthObject, String(lengthValue));
  return assemble(objects);
}

export function makeIndirectLengthPdfWithFreeTarget() {
  const content = 'q\nQ\n';
  let body = '%PDF-1.4\n'; const offsets = [];
  for (const [number, value] of [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>'],
    [4, `<< /Length 5 0 R >>\nstream\n${content}endstream`],
  ]) {
    offsets[number] = Buffer.byteLength(body, 'latin1');
    body += `${number} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (let number = 1; number <= 4; number += 1) body += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  body += '0000000000 00000 f \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n';
  body += `${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function makeManyLargeHeadersPdf() {
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>'],
    [4, '<< /Length 4 >>\nstream\nq\nQ\nendstream'],
  ]);
  const payload = 'x'.repeat(1_000);
  for (let number = 5; number <= 10_004; number += 1) objects.set(number, `<< /Payload (${payload}) >>`);
  return assemble(objects);
}
