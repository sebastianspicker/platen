import { createHash } from 'node:crypto';
import { parsePdfStructure, resolvePdfObject } from '../pdf-classic-structure.mjs';
import { planClassicObjectTransaction } from '../pdf-classic-object-transaction.mjs';
import { pdfDictionary } from '../pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from '../pdf-classic-text-string.mjs';
import { HostError } from '../host-error.mjs';

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function appendAndVerifyInertAnnotation({
  sourceBytes,
  sourceStructure,
  pageRef,
  page,
  pageEntries,
  annotValue,
  subtype,
  contents,
  annotationName,
  rect,
}) {
  let transaction;
  try {
    transaction = planClassicObjectTransaction({
      sourceBytes,
      sourceStructure,
      updates: [{
        reference: pageRef,
        value: Object.freeze({ type: 'dict', entries: new Map([...pageEntries.entries()]) }),
      }],
      additions: [{ id: 'inert-annot', value: annotValue }],
      info: { kind: 'preserve' },
      changingId: null,
    });
  } catch (error) {
    fail('ANNOTATION_PLAN_FAILED', error?.message ?? 'Could not plan annotation revision.', 502);
  }
  const annotRef = transaction.referencesById?.['inert-annot'];
  if (!annotRef) fail('ANNOTATION_PLAN_FAILED', 'Planner did not allocate annotation reference.', 502);
  const bytes = Buffer.concat([sourceBytes, transaction.revision.bytes]);
  const out = parsePdfStructure(bytes);
  const outPage = pdfDictionary(resolvePdfObject(out, pageRef).value);
  const outAnnots = outPage.get('Annots');
  if (!outAnnots || outAnnots.type !== 'array' || outAnnots.values.length < 1) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation was not attached to page.', 502);
  }
  const last = outAnnots.values[outAnnots.values.length - 1];
  if (last.type !== 'ref') fail('ANNOTATION_OUTPUT_INVALID', 'Annotation ref missing.', 502);
  const annotDict = pdfDictionary(resolvePdfObject(out, last).value);
  if (annotDict.get('Subtype')?.value !== subtype) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation subtype missing in output.', 502);
  }
  const contentsOut = annotDict.get('Contents');
  if (!contentsOut?.bytes?.equals(pdfUtf16BeString(contents).bytes)) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation contents not preserved.', 502);
  }
  const nameOut = annotDict.get('NM');
  if (annotationName !== undefined && !nameOut?.bytes?.equals(pdfUtf16BeString(annotationName).bytes)) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation name not preserved.', 502);
  }
  return Object.freeze({
    bytes,
    proof: Object.freeze({
      subtype,
      page,
      contentsSha256: createHash('sha256').update(contents).digest('hex'),
      rect: Object.freeze([...rect]),
      ...(annotationName === undefined ? {} : {
        name: annotationName,
        nameSha256: createHash('sha256').update(annotationName).digest('hex'),
      }),
      sourcePrefixPreserved: true,
      annotationReference: last,
      outputSha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  });
}
