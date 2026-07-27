import { createHash } from 'node:crypto';
import { pdfReference } from './pdf-classic-syntax.mjs';
import { pendingPdfObjectReference, planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { escapePageTextPdfLiteral, PDF_PAGE_TEXT_PROFILE, normalizePageTextRequest } from './pdf-page-text-contract.mjs';

export function writeIncrementalPdfPageText({ sourceBytes, requestValue, checkedSource, selectedPage, pdfDict, pdfArray, pdfNumber, changedId, unsupported }) {
  const request = normalizePageTextRequest(requestValue);
  const structure = checkedSource(sourceBytes);
  const state = selectedPage(structure, { page: request.page, rect: { x: request.x, y: request.y, width: 1, height: 1 } });
  if (state.page.entries.has('Resources')) throw unsupported();
  const stream = Buffer.from(`BT /F1 ${request.size} Tf 0 0 0 rg ${request.x} ${request.y} Td (${escapePageTextPdfLiteral(request.text)}) Tj ET\n`, 'latin1');
  const streamRef = pendingPdfObjectReference('text-stream');
  const fontRef = pendingPdfObjectReference('text-font');
  const resources = pdfDict([['Font', pdfDict([['F1', fontRef]])]]);
  const pageValue = pdfDict([...state.page.entries, ['Resources', resources], ['Contents', pdfArray([streamRef])]]);
  const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: structure, updates: [{ reference: state.page.reference, value: pageValue }], additions: [
    { id: 'text-stream', value: pdfDict([['Length', pdfNumber(stream.length)]]), streamBytes: stream },
    { id: 'text-font', value: pdfDict([['Type', { type: 'name', value: 'Font' }], ['Subtype', { type: 'name', value: 'Type1' }], ['BaseFont', { type: 'name', value: 'Helvetica' }]]) },
  ], info: { kind: 'preserve' }, changingId: structure.id ? changedId(sourceBytes, request) : null });
  const bytes = Buffer.concat([sourceBytes, transaction.revision.bytes]);
  return Object.freeze({ bytes, proof: Object.freeze({
    profile: PDF_PAGE_TEXT_PROFILE, page: request.page, x: request.x, y: request.y, size: request.size,
    textSha256: createHash('sha256').update(request.text, 'utf8').digest('hex'),
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
    sourcePrefixPreserved: bytes.subarray(0, sourceBytes.length).equals(sourceBytes),
    textStreamObjectNumber: transaction.referencesById['text-stream'].object,
    fontObjectNumber: transaction.referencesById['text-font'].object, resourceName: 'F1', baseFont: 'Helvetica',
  }) });
}
