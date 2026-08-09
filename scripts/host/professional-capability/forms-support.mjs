import { createHash } from 'node:crypto';
import { result, requireString, requireBytes, fail, sha256 } from './support.mjs';
import { opFormsFillSave } from './real-ops.mjs';
import {
  preparePdfAcroFormTextField,
  inspectPdfAcroFormTextField,
  PDF_ACROFORM_TEXT_FIELD_PROFILE,
} from '../pdf-acroform-text-field-writer.mjs';
import {
  preparePdfAcroFormSignatureField,
  inspectPdfAcroFormSignatureField,
  PDF_ACROFORM_SIGNATURE_FIELD_PROFILE,
} from '../pdf-acroform-signature-field-writer.mjs';
import {
  preparePdfAcroFormBarcode,
  inspectPdfAcroFormBarcode,
} from '../pdf-acroform-barcode-writer.mjs';
import {
  PDF_ACROFORM_BARCODE_PROFILE,
  PDF_ACROFORM_BARCODE_SYMBOLOGY,
} from '../pdf-acroform-barcode-contract.mjs';
import {
  preparePdfAcroFormTabOrderTooltip,
  inspectPdfAcroFormTabOrderTooltip,
} from '../pdf-acroform-tab-order-tooltip-writer.mjs';
import { PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE } from '../pdf-acroform-tab-order-tooltip-contract.mjs';
import { formFixture, digest } from './fixtures.mjs';
import { decodedAcroFormName, validateAcroFormValues } from '../pdf-acroform-validation-core.mjs';
import { PDF_ACROFORM_FILL_SAVE_PROFILE, preparePdfAcroFormFillSave } from '../pdf-acroform-fill-save-writer.mjs';

const FAMILY = 'forms';

function sourceOf(ctx = {}) {
  const supplied = [];
  const readSource = (value, label) => {
    try { return requireBytes(value, label); } catch { fail('FORM_SOURCE_INVALID', 'The source must be bounded PDF bytes.', 422); }
  };
  if (ctx.demoFixture === true) {
    if (ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined) {
      fail('FORM_DEMO_SOURCE_CONFLICT', 'demoFixture cannot be combined with a supplied source.', 422);
    }
    const demo = readSource(formFixture(), 'demoFixture');
    return Object.freeze({
      source: Buffer.from(demo),
      sourceSha256: sha256(demo),
      supplied: false,
      demoFixtureUsed: true,
      professionalProof: false,
      sourceBytes: demo.length,
    });
  }
  if (ctx.sourcePdf !== undefined) supplied.push(readSource(ctx.sourcePdf, 'sourcePdf'));
  if (ctx.sourceBytes !== undefined) supplied.push(readSource(ctx.sourceBytes, 'sourceBytes'));
  if (supplied.length === 0) fail('FORM_SOURCE_REQUIRED', 'A source PDF is required for this forms operation.', 422);
  const selected = supplied[0];
  const source = Buffer.from(selected);
  const sourceSha256 = sha256(source);
  if (supplied.length > 1 && supplied.some((bytes) => !Buffer.from(bytes).equals(source))) {
    fail('SOURCE_VERSION_MISMATCH', 'sourcePdf and sourceBytes do not identify the same immutable source.', 409);
  }
  if (ctx.sourceSha256 !== undefined && ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied source digest does not match the source PDF.', 409);
  }
  return Object.freeze({
    source,
    sourceSha256,
    supplied: supplied.length > 0,
    demoFixtureUsed: false,
    professionalProof: false,
    sourceBytes: source.length,
  });
}

function formsString(value, label, options, prefix) {
  try { return requireString(value, label, options); } catch { fail(`${prefix}_INVALID_REQUEST`, `${label} is invalid for the bounded professional subset.`, 400); }
}

function rejectDemoSource(ctx = {}) {
  if (ctx.demoFixture === true && (ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined)) {
    fail('FORM_DEMO_SOURCE_CONFLICT', 'demoFixture cannot be combined with a supplied source.', 422);
  }
}

function mapWriterError(error, prefix) {
  const code = String(error?.code ?? '');
  if (code.includes('OUTPUT')) fail(`${prefix}_OUTPUT_INVALID`, 'Local form writer output validation rejected the output.', 502);
  if (code.includes('UNSUPPORTED')) fail(`${prefix}_SOURCE_UNSUPPORTED`, 'The source is outside the bounded passive forms subset.', 422);
  if (code.includes('INVALID')) fail(`${prefix}_INVALID_REQUEST`, 'The form request is invalid for the bounded professional subset.', 400);
  fail(`${prefix}_FAILED`, 'The local forms operation could not be completed.', 502);
}

function runWriter(prefix, operation) {
  try {
    return operation();
  } catch (error) {
    mapWriterError(error, prefix);
  }
}

function textRequest(bound, ctx, fieldName) {
  return {
    profile: PDF_ACROFORM_TEXT_FIELD_PROFILE,
    sourceSha256: bound.sourceSha256,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    fieldName,
    rect: ctx.rect ?? { x: 72, y: 700, width: 180, height: 24 },
  };
}

function signatureRequest(bound, ctx, fieldName) {
  return {
    profile: PDF_ACROFORM_SIGNATURE_FIELD_PROFILE,
    sourceSha256: bound.sourceSha256,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    fieldName,
    rect: ctx.rect ?? { x: 72, y: 700, width: 180, height: 24 },
  };
}

function mutationResult(capabilityId, method, bound, written, proof, extra = {}) {
  const outputSha256 = digest(written.bytes);
  const pdf = written.bytes;
  if (!pdf.subarray(0, bound.source.length).equals(bound.source)) {
    fail('FORM_SOURCE_PREFIX_INVALID', 'The derived form artifact does not preserve the immutable source prefix.', 502);
  }
  return result(capabilityId, {
    familyId: FAMILY,
    method,
    sourceSha256: bound.sourceSha256,
    outputSha256,
    pdf,
    bytes: pdf.length,
    sourcePrefixPreserved: true,
    sourceProvided: bound.supplied,
    demoFixtureUsed: bound.demoFixtureUsed,
    professionalProof: bound.professionalProof,
    proofStatus: 'partial',
    validationBoundary: 'in-process-writer-inspection-only',
    proof,
    ...extra,
  });
}

function authorTextField(ctx, capabilityId, fieldName, method = 'local-pdf-acroform-text-field') {
  const bound = sourceOf(ctx);
  const request = textRequest(bound, ctx, formsString(fieldName, 'fieldName', { min: 1, max: 80 }, 'FORM_TEXT_FIELD'));
  const written = runWriter('FORM_TEXT_FIELD', () => preparePdfAcroFormTextField(bound.source, request));
  const proof = runWriter('FORM_TEXT_FIELD', () => inspectPdfAcroFormTextField(bound.source, written.bytes, request));
  return mutationResult(capabilityId, method, bound, written, proof, {
    fieldName: request.fieldName,
    request,
  });
}

function inspectFilledTextArtifact(bound, filled, expectedValue) {
  if (!Buffer.isBuffer(filled.pdf) || !filled.widgetReference) {
    fail('FORM_FILL_SAVE_OUTPUT_INVALID', 'Filled form output is missing its widget artifact.', 502);
  }
  const pdf = filled.pdf;
  if (!pdf.subarray(0, bound.source.length).equals(bound.source)) {
    fail('FORM_FILL_SAVE_OUTPUT_INVALID', 'Filled form output does not preserve the source prefix.', 502);
  }
  let structure;
  try {
    structure = parsePdfStructure(pdf);
    const widget = pdfDictionary(resolvePdfObject(structure, filled.widgetReference).value);
    const value = widget.get('V');
    const expected = pdfUtf16BeString(expectedValue).bytes;
    if (widget.get('Subtype')?.value !== 'Widget' || widget.get('FT')?.value !== 'Tx'
      || value?.type !== 'string' || !value.bytes.equals(expected)) throw new Error('semantic mismatch');
  } catch {
    fail('FORM_FILL_SAVE_OUTPUT_INVALID', 'Local filled-widget validation rejected the output.', 502);
  }
  return pdf;
}

function decodedFieldName(value) {
  return decodedAcroFormName(value);
}

function sourceBoundFillSave(bound, ctx) {
  const request = { profile: PDF_ACROFORM_FILL_SAVE_PROFILE, sourceSha256: bound.sourceSha256, fieldName: ctx.fieldName, value: ctx.value };
  try {
    const built = preparePdfAcroFormFillSave(bound.source, request);
    return { pdf: built.bytes, fieldName: ctx.fieldName, value: ctx.value, widgetReference: built.proof.widgetReference, fieldType: built.proof.fieldType };
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_FILL_SAVE_SOURCE') fail('FORM_FILL_SAVE_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive forms subset.', 422);
    if (error?.code === 'INVALID_PDF_ACROFORM_FILL_SAVE_OUTPUT') fail('FORM_FILL_SAVE_OUTPUT_INVALID', 'The derived form output is invalid.', 502);
    fail('FORM_FILL_SAVE_INVALID_REQUEST', 'The bounded fill/save request is invalid.', 400);
  }
}

function extractStaticText(source) {
  let structure;
  try {
    structure = parsePdfStructure(source);
  } catch {
    fail('FORM_DETECT_SOURCE_INVALID', 'The static source is not a valid bounded classic PDF.', 422);
  }
  const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  const pageContentRefs = [];
  const seen = new Set();
  const walkPages = (reference) => {
    const key = `${reference.object}:${reference.generation}`;
    if (seen.has(key)) fail('FORM_DETECT_SOURCE_INVALID', 'The static source page tree contains a cycle or alias.', 422);
    seen.add(key);
    const entries = pdfDictionary(resolvePdfObject(structure, reference).value);
    if (entries.get('Type')?.value === 'Pages') {
      if (entries.get('Kids')?.type !== 'array') fail('FORM_DETECT_SOURCE_INVALID', 'The static source page tree is malformed.', 422);
      for (const child of entries.get('Kids').values) {
        if (child?.type !== 'ref') fail('FORM_DETECT_SOURCE_INVALID', 'The static source page tree is malformed.', 422);
        walkPages(child);
      }
      return;
    }
    if (entries.get('Type')?.value !== 'Page') fail('FORM_DETECT_SOURCE_INVALID', 'The static source page tree is malformed.', 422);
    const contents = entries.get('Contents');
    if (contents?.type === 'ref') pageContentRefs.push(contents);
    else if (contents?.type === 'array') {
      for (const child of contents.values) {
        if (child?.type !== 'ref') fail('FORM_DETECT_SOURCE_INVALID', 'The static source content tree is malformed.', 422);
        pageContentRefs.push(child);
      }
    }
  };
  if (catalog.get('Pages')?.type !== 'ref') fail('FORM_DETECT_SOURCE_INVALID', 'The static source has no direct page tree.', 422);
  walkPages(catalog.get('Pages'));
  const chunks = [];
  for (const reference of pageContentRefs) {
    const object = resolvePdfObject(structure, reference);
    if (!object.stream) fail('FORM_DETECT_SOURCE_INVALID', 'The static source page content is not a stream.', 422);
    const bytes = structure.buffer.subarray(object.streamStart, object.streamStart + object.streamLength);
    const text = bytes.toString('latin1');
    const matches = text.matchAll(/\(((?:\\.|[^()])*)\)\s*Tj/gu);
    for (const match of matches) {
      const value = match[1].replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\');
      chunks.push(value);
    }
  }
  return chunks.join('\n');
}

function detectCandidates(text) {
  const fields = [];
  for (const line of text.split(/\n+/u)) {
    const match = /^([A-Za-z][A-Za-z0-9 /_-]{1,40})\s*:\s*$/u.exec(line.trim());
    if (match) fields.push({ name: match[1].trim(), kind: 'text' });
  }
  return fields;
}

function normalizeValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('FORM_VALIDATE_INVALID_REQUEST', 'values must be a plain object.', 400);
  }
  return value;
}

function validateValues(values, rules) {
  try { return validateAcroFormValues(values, rules, { allowPattern: true }).map(({ field, code }) => ({ field, code })); }
  catch { fail('FORM_VALIDATE_INVALID_REQUEST', 'Validation values or rules are invalid.', 400); }
}


export {
  authorTextField,
  decodedFieldName,
  detectCandidates,
  extractStaticText,
  formsString,
  inspectFilledTextArtifact,
  mapWriterError,
  mutationResult,
  normalizeValues,
  rejectDemoSource,
  runWriter,
  signatureRequest,
  sourceBoundFillSave,
  sourceOf,
  textRequest,
  validateValues,
};
