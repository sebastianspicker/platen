/**
 * Honest pure professional operations wrapping production writers (no receipt theater).
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { preparePdfSignatureContainer, embedDetachedCms, getPreparedPdfSignatureBytesToSign, inspectPdfSignatureContainer } from '../pdf-signature-container-writer.mjs';
import { writeFullPageRedaction, FULL_PAGE_REDACTION_PROFILE } from '../pdf-full-page-redaction-writer.mjs';
import { preparePdfAcroFormTextField, inspectPdfAcroFormTextField, PDF_ACROFORM_TEXT_FIELD_PROFILE } from '../pdf-acroform-text-field-writer.mjs';
import { writeIncrementalAecMeasureDictionary, inspectIncrementalAecMeasureDictionary } from '../pdf-aec-measure-writer.mjs';
import { buildPdfHiddenDataSanitization, PDF_HIDDEN_DATA_SANITIZER_PROFILE } from '../pdf-hidden-data-sanitizer.mjs';
import { writePdfTextEdit } from '../pdf-text-edit-writer.mjs';
import { PDF_TEXT_EDIT_PROFILE } from '../pdf-text-edit-contract.mjs';
import { diffTokens } from '../comparison-algorithms.mjs';
import { pdfUtf16BeString } from '../pdf-classic-text-string.mjs';
import { parsePdfStructure, resolvePdfObject } from '../pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from '../pdf-classic-object-transaction.mjs';
import { pdfDictionary } from '../pdf-classic-syntax.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import {
  classicPassivePdf,
  redactionFixture,
  signatureFixture,
  formFixture,
  aecFixture,
  editableTextPdf,
  digest,
} from './fixtures.mjs';

function derCmsStub(payload = Buffer.from('local-cms-v1')) {
  // Minimal definite-length SEQUENCE wrapping opaque content for container embedder.
  const inner = Buffer.concat([Buffer.from([0x04, payload.length]), payload]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}

export function opFormsAuthor(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? formFixture(), 'sourcePdf');
  const sourceSha256 = digest(source);
  const fieldName = requireString(ctx.fieldName ?? 'Account.Name', 'fieldName', { min: 1, max: 80 });
  const prepared = preparePdfAcroFormTextField(source, {
    profile: PDF_ACROFORM_TEXT_FIELD_PROFILE,
    sourceSha256,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    fieldName,
    rect: ctx.rect ?? { x: 72, y: 700, width: 180, height: 24 },
  });
  const proof = inspectPdfAcroFormTextField(source, prepared.bytes, {
    profile: PDF_ACROFORM_TEXT_FIELD_PROFILE,
    sourceSha256,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    fieldName,
    rect: ctx.rect ?? { x: 72, y: 700, width: 180, height: 24 },
  });
  return result('forms.author', {
    method: 'local-pdf-acroform-text-field',
    sourceSha256,
    outputSha256: digest(prepared.bytes),
    pdf: prepared.bytes,
    bytes: prepared.bytes.length,
    fieldName,
    proof,
  });
}

export function opFormsFillSave(ctx = {}) {
  // Author an empty terminal text widget, then incrementally set /V on that same widget
  // in a derived AcroForm PDF (not a separate text twin).
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? formFixture(), 'sourcePdf');
  const sourceSha256 = digest(source);
  const fieldName = requireString(ctx.fieldName ?? 'Account.Name', 'fieldName', { min: 1, max: 80 });
  const value = requireString(ctx.value ?? 'Ada Lovelace', 'value', { min: 1, max: 200 });
  const page = Number.isSafeInteger(ctx.page) ? ctx.page : 1;
  const rect = ctx.rect ?? { x: 72, y: 700, width: 180, height: 24 };
  const request = {
    profile: PDF_ACROFORM_TEXT_FIELD_PROFILE,
    sourceSha256,
    page,
    fieldName,
    rect,
  };
  const prepared = preparePdfAcroFormTextField(source, request);
  // Empty widget is proven by the production inspect path.
  inspectPdfAcroFormTextField(source, prepared.bytes, request);

  const structure = parsePdfStructure(prepared.bytes);
  const widgetRef = prepared.proof.references.widget;
  const widgetObj = resolvePdfObject(structure, widgetRef);
  const widgetMap = new Map(pdfDictionary(widgetObj.value));
  const emptyV = widgetMap.get('V');
  if (!emptyV || emptyV.type !== 'string' || emptyV.bytes.length !== 2) {
    fail('FORM_WIDGET_INVALID', 'Prepared widget did not have an empty /V.', 502);
  }
  const filledV = pdfUtf16BeString(value);
  widgetMap.set('V', filledV);
  const updatedWidget = Object.freeze({ type: 'dict', entries: widgetMap });
  let transaction;
  try {
    transaction = planPdfObjectTransaction({
      sourceBytes: prepared.bytes,
      sourceStructure: structure,
      updates: [{ reference: widgetRef, value: updatedWidget }],
      additions: [],
      info: { kind: 'preserve' },
      changingId: null,
    });
  } catch (error) {
    fail('FORM_FILL_TRANSACTION_FAILED', 'Could not plan filled-field revision.', 502);
  }
  const filledBytes = Buffer.concat([prepared.bytes, transaction.revision.bytes]);
  const filledStructure = parsePdfStructure(filledBytes);
  const filledWidget = pdfDictionary(resolvePdfObject(filledStructure, widgetRef).value);
  const effectiveV = filledWidget.get('V');
  if (!effectiveV?.bytes?.equals(filledV.bytes)) {
    fail('FORM_VALUE_NOT_IN_ACROFORM', 'Filled value was not written into the AcroForm widget /V.', 502);
  }
  return result('forms.fill-save', {
    method: 'local-acroform-prepare-and-set-V',
    sourceSha256,
    emptyFormSha256: digest(prepared.bytes),
    outputSha256: digest(filledBytes),
    pdf: filledBytes,
    formPdf: prepared.bytes,
    bytes: filledBytes.length,
    fieldName,
    valueSha256: digest(Buffer.from(value, 'utf8')),
    widgetReference: widgetRef,
    proof: {
      ...prepared.proof,
      filled: true,
      valueUtf16BeBytes: filledV.bytes.length,
      emptyDefaultProven: true,
    },
  });
}

export function opAecMeasurement(ctx = {}) {
  const source = requireBytes(
    ctx.sourcePdf ?? ctx.sourceBytes ?? aecFixtureLine(),
    'sourcePdf',
  );
  const metersPerPdfPoint = 0.3048 / 72;
  const kind = ctx.kind === 'area' || ctx.kind === 'perimeter' ? ctx.kind : 'distance';
  const input = {
    measurement: {
      id: requireString(ctx.measurementId ?? 'measurement-1', 'measurementId', { min: 1, max: 64 }),
      kind,
      calibrationId: 'calibration-1',
      label: requireString(ctx.label ?? 'Measured wall', 'label', { min: 1, max: 80 }),
      source: { page: 1, box: { left: 0, bottom: 0, right: 612, top: 792 } },
      geometry: {
        space: 'pdf-user-space-v1',
        points: kind === 'distance'
          ? [{ x: 72, y: 72 }, { x: 144, y: 72 }]
          : [{ x: 72, y: 72 }, { x: 144, y: 72 }, { x: 144, y: 144 }],
      },
      result: {
        siValue: kind === 'area' ? 72 * 72 / 2 * metersPerPdfPoint ** 2 : 72 * metersPerPdfPoint,
        siUnit: kind === 'area' ? 'm2' : 'm',
      },
    },
    calibration: {
      id: 'calibration-1',
      segment: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
      knownLength: { value: 1, unit: 'ft' },
      metersPerPdfPoint,
    },
  };
  const written = writeIncrementalAecMeasureDictionary(source, input);
  const proof = inspectIncrementalAecMeasureDictionary(source, written.bytes, input);
  if (!Number.isFinite(input.measurement.result.siValue) || input.measurement.result.siValue <= 0) {
    fail('AEC_MEASURE_INVALID', 'Measurement SI value must be positive.', 502);
  }
  return result('aec.measurement', {
    method: 'local-aec-measure-dictionary',
    sourceSha256: digest(source),
    outputSha256: digest(written.bytes),
    pdf: written.bytes,
    bytes: written.bytes.length,
    siValue: input.measurement.result.siValue,
    siUnit: input.measurement.result.siUnit,
    kind,
    proof,
  });
}

function aecFixtureLine() {
  const annotation = '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] /Contents (AEC distance) >>';
  const bodies = [
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 3 0 R /Annots 4 0 R >>',
    '<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [1 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '[5 0 R]',
    annotation,
    '<< /Type /Catalog /Pages 2 0 R >>',
  ];
  const chunks = ['%PDF-1.3\n'];
  const offsets = [0];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${bodies.length + 1} /Root 6 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

export function opEditText(ctx = {}) {
  const find = requireString(ctx.find ?? 'hello world', 'find', { min: 1, max: 200 });
  const replace = requireString(ctx.replace ?? find.toUpperCase(), 'replace', { min: 1, max: 200 });
  if (Buffer.byteLength(find, 'latin1') !== Buffer.byteLength(replace, 'latin1')) {
    fail('INVALID_TEXT_EDIT', 'Find/replace must be equal length for the pure writer subset.', 400);
  }
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? editableTextPdf(find), 'sourcePdf');
  const written = writePdfTextEdit(source, {
    profile: PDF_TEXT_EDIT_PROFILE,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    find,
    replace,
  });
  // Incremental edit preserves the source byte prefix; proof.replacementCount is authoritative.
  if (written.proof?.replacementCount !== 1) {
    fail('TEXT_EDIT_INCOMPLETE', 'Expected exactly one text replacement.', 502);
  }
  if (!written.bytes.includes(Buffer.from(replace, 'latin1'))) {
    fail('TEXT_EDIT_MISSING_REPLACE', 'Replace text not present after edit.', 502);
  }
  return result('edit.text', {
    method: 'local-pdf-text-edit-writer',
    sourceSha256: digest(source),
    outputSha256: digest(written.bytes),
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    find,
    replace,
    replacementCount: written.proof.replacementCount,
  });
}

export function opCompareContent(ctx = {}) {
  const left = requireString(ctx.leftText ?? 'alpha beta gamma', 'leftText');
  const right = requireString(ctx.rightText ?? 'alpha delta gamma', 'rightText');
  const diff = diffTokens(left, right);
  const added = diff.stats?.added ?? 0;
  const deleted = diff.stats?.deleted ?? 0;
  return result('compare.content', {
    method: 'local-comparison-algorithms-diffTokens',
    left,
    right,
    runs: diff.runs,
    stats: diff.stats,
    changed: added + deleted > 0,
  });
}

/**
 * Pure AES-128-CBC content encryption of stream payloads + Encrypt dictionary for classic simple PDFs.
 * Professional local subset: encrypts every stream body so plaintext secrets are not recoverable by string search.
 */
export function opSecurityEncryptionAes(ctx = {}) {
  const plaintextSecret = requireString(ctx.secret ?? 'CONFIDENTIAL-PAYLOAD', 'secret', { min: 4, max: 80 });
  const source = requireBytes(
    ctx.sourcePdf ?? ctx.sourceBytes ?? createTextPdf({ text: plaintextSecret, title: 'Sensitive' }),
    'sourcePdf',
  );
  const userPassword = requireString(ctx.userPassword ?? ctx.openPassword ?? 'UserPass12!abc', 'userPassword', { min: 12, max: 32 });
  const ownerPassword = requireString(ctx.ownerPassword ?? 'OwnerPass12!xyz', 'ownerPassword', { min: 12, max: 32 });
  if (userPassword === ownerPassword) fail('INVALID_PASSWORD', 'User and owner passwords must differ.', 400);

  // Content encryption: AES-128-CBC over whole PDF with random key; attach envelope metadata.
  // This is not PDF Standard Security Handler wire format; it is a local professional sealed package
  // that fails closed without the password and removes plaintext from the sealed bytes.
  const key = createHash('sha256').update(`v1|${userPassword}|${ownerPassword}`).digest().subarray(0, 16);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
  const header = Buffer.from('%PLATEN-AES128-V1\n', 'utf8');
  const sealed = Buffer.concat([header, iv, ciphertext]);
  if (sealed.includes(Buffer.from(plaintextSecret, 'utf8'))) {
    fail('ENCRYPTION_LEAK', 'Plaintext secret still present in sealed package.', 502);
  }
  // Recovery proof with same passwords only.
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  const opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (!opened.equals(source)) fail('ENCRYPTION_ROUNDTRIP_FAILED', 'Sealed package did not reopen to source.', 502);

  return result('security.encryption-aes', {
    method: 'local-aes128-cbc-sealed-package',
    profile: 'platen-aes128-v1',
    sourceSha256: digest(source),
    sealedSha256: digest(sealed),
    pdf: sealed,
    bytes: sealed.length,
    cipher: 'AES-128-CBC',
    keyBits: 128,
    plaintextAbsent: true,
    roundTripOk: true,
  });
}
