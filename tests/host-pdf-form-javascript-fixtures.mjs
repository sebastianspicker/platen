import { createHash } from 'node:crypto';

const hex = (value) => Buffer.from(value, 'utf8').toString('hex').toUpperCase();
export function makeFormJavaScriptPdf({
  actions = [{ trigger: 'K', script: 'event.rc = true;' }], content = 'q\nQ\n',
  catalogExtra = '', actionExtra = '', indirectScript = false, sharedAction = false,
  duplicateWidgetOnSecondPage = false, duplicateRootFieldName = false,
  fieldName = 'OrderCode', extraObjects = [],
} = {}) {
  const objects = new Map(); const fieldReference = 6;
  let nextObject = duplicateWidgetOnSecondPage ? 9 : duplicateRootFieldName ? 8 : 7; const aa = [];
  for (const [index, action] of actions.entries()) {
    const actionReference = sharedAction && index > 0 ? 7 : nextObject++;
    aa.push(`/${action.trigger} ${actionReference} 0 R`);
    if (!objects.has(actionReference)) {
      objects.set(actionReference, indirectScript
        ? `<< /S /JavaScript /JS ${nextObject} 0 R${actionExtra} >>`
        : `<< /S /JavaScript /JS <${hex(action.script)}>${actionExtra} >>`);
    }
    if (indirectScript && !objects.has(nextObject)) {
      objects.set(nextObject++, `<${hex(action.script)}>`);
    }
  }
  const hasField = actions.length > 0;
  const fieldReferences = hasField ? [fieldReference, ...(duplicateRootFieldName ? [7] : [])] : [];
  const fieldReferenceList = fieldReferences.map((reference) => `${reference} 0 R`).join(' ');
  objects.set(1, `<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R${catalogExtra} >>`);
  objects.set(2, `<< /Type /Pages /Count ${duplicateWidgetOnSecondPage ? 2 : 1} /Kids [3 0 R${duplicateWidgetOnSecondPage ? ' 7 0 R' : ''}] >>`);
  objects.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R${hasField ? ` /Annots [${fieldReferenceList}]` : ''} >>`);
  objects.set(4, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(5, `<< /Fields [${fieldReferenceList}] >>`);
  if (hasField) {
    objects.set(fieldReference, `<< /Type /Annot /Subtype /Widget /FT /Tx /T <${hex(fieldName)}> /Rect [72 640 312 688] /P 3 0 R /AA << ${aa.join(' ')} >> >>`);
    if (duplicateRootFieldName) objects.set(7, `<< /Type /Annot /Subtype /Widget /FT /Tx /T <${hex(fieldName)}> /Rect [72 580 312 628] /P 3 0 R >>`);
  }
  if (duplicateWidgetOnSecondPage) {
    objects.set(7, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 8 0 R${hasField ? ` /Annots [${fieldReference} 0 R]` : ''} >>`);
    objects.set(8, '<< /Length 0 >>\nstream\nendstream');
  }
  for (const [object, body] of extraObjects) objects.set(object, body);
  const ordered = [...objects].sort(([left], [right]) => left - right);
  const maximum = Math.max(...ordered.map(([object]) => object));
  const chunks = ['%PDF-1.7\n% /S /JavaScript /JS (comment-decoy)\n']; const offsets = new Map();
  for (const [object, body] of ordered) {
    offsets.set(object, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${object} 0 obj\n${body}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${maximum + 1}\n0000000000 65535 f \n`);
  for (let object = 1; object <= maximum; object += 1) {
    chunks.push(offsets.has(object)
      ? `${String(offsets.get(object)).padStart(10, '0')} 00000 n \n`
      : '0000000000 00000 f \n');
  }
  chunks.push(`trailer\n<< /Size ${maximum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}
export function formJavaScriptRequest(source, overrides = {}) {
  return {
    profile: 'local-pdf-form-javascript-inventory-v1',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    ...overrides,
  };
}
