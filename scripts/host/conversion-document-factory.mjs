import { Readable } from 'node:stream';
import { createOperationProvenance } from './operation-provenance.mjs';
import { createBlankPdf, createTextPdf } from './pdf-factory.mjs';
import { cleanConversionStem } from './conversion-admission.mjs';

export async function createBlankDocument(documents, {
  pages = 1,
  widthPoints = 612,
  heightPoints = 792,
  title = 'Untitled',
} = {}) {
  const bytes = createBlankPdf({ pages, widthPoints, heightPoints, title });
  const operation = createOperationProvenance({
    type: 'create-blank-pdf',
    inputs: [],
    parameters: { pages, widthPoints, heightPoints, title },
    expected: { pageCount: pages },
    validation: {
      passed: true, validators: ['local-pdf-factory'], pageCount: pages,
    },
  });
  return documents.createDocument({
    stream: Readable.from([bytes]), displayName: 'untitled.pdf', operation,
  });
}

export async function createTextDocument(documents, {
  text = '',
  title = 'Local text document',
} = {}) {
  const bytes = createTextPdf({ text, title });
  const operation = createOperationProvenance({
    type: 'create-text-pdf',
    inputs: [],
    parameters: { title, textLength: String(text).length },
    expected: { pageCount: 1, extractableText: Boolean(String(text).trim()) },
    validation: {
      passed: true, validators: ['local-pdf-factory'], pageCount: 1,
    },
  });
  return documents.createDocument({
    stream: Readable.from([bytes]),
    displayName: `${cleanConversionStem(title)}.pdf`,
    operation,
  });
}
