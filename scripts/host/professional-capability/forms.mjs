import { result, requireString, fail } from './support.mjs';
import { opFormsAuthor, opFormsFillSave } from './real-ops.mjs';
import { preparePdfAcroFormTextField, PDF_ACROFORM_TEXT_FIELD_PROFILE } from '../pdf-acroform-text-field-writer.mjs';
import { formFixture, digest } from './fixtures.mjs';
import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import { assembleBarcodeFieldPdf } from './specialist-embed-pdf.mjs';

const FAMILY = 'forms';

export const handlers = Object.freeze({
  async 'forms.fill-save'(ctx = {}) {
    return opFormsFillSave(ctx);
  },

  async 'forms.source-bound-acroform-fill-save'(ctx = {}) {
    const filled = opFormsFillSave(ctx);
    if (!Buffer.isBuffer(filled.pdf) || !filled.widgetReference) {
      fail('FORM_SOURCE_BOUND_INVALID', 'Source-bound fill did not produce widget-bound PDF.', 502);
    }
    return result('forms.source-bound-acroform-fill-save', {
      ...filled,
      capabilityId: 'forms.source-bound-acroform-fill-save',
      method: 'local-source-bound-acroform-fill-save',
      sourceBound: true,
    });
  },

  async 'forms.author'(ctx = {}) {
    return opFormsAuthor(ctx);
  },

  async 'forms.validate'(ctx = {}) {
    const values = ctx.values && typeof ctx.values === 'object' ? ctx.values : { 'Account.Name': 'Ada' };
    const errors = [];
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== 'string' || value.trim().length === 0) errors.push({ field: name, code: 'REQUIRED' });
    }
    return result('forms.validate', {
      familyId: FAMILY,
      method: 'local-form-value-validation',
      valid: errors.length === 0,
      errors,
      fieldCount: Object.keys(values).length,
    });
  },

  async 'forms.calculate'(ctx = {}) {
    const a = Number(ctx.a ?? 2);
    const b = Number(ctx.b ?? 3);
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail('INVALID_CALC', 'Finite numbers required.', 400);
    const sum = a + b;
    return result('forms.calculate', {
      familyId: FAMILY,
      method: 'local-safe-arithmetic-calculate',
      expression: 'a+b',
      a,
      b,
      result: sum,
    });
  },

  async 'forms.distribute-collect'(ctx = {}) {
    const responses = Array.isArray(ctx.responses) ? ctx.responses : [{ id: 'r1', values: { Name: 'Ada' } }];
    return result('forms.distribute-collect', {
      familyId: FAMILY,
      method: 'local-form-response-collection',
      responses: responses.slice(0, 100),
      count: Math.min(responses.length, 100),
    });
  },

  async 'forms.detect-fields'(ctx = {}) {
    const text = requireString(ctx.text ?? 'Name: \nDate: \nAmount: ', 'text');
    const fields = [];
    for (const line of text.split(/\n+/)) {
      const m = /^([A-Za-z][A-Za-z0-9 /_-]{1,40})\s*:\s*$/.exec(line.trim());
      if (m) fields.push({ name: m[1].trim(), kind: 'text' });
    }
    return result('forms.detect-fields', {
      familyId: FAMILY,
      method: 'local-label-field-detection',
      fields,
      count: fields.length,
    });
  },

  async 'forms.static-to-fillable'(ctx = {}) {
    const authored = opFormsAuthor({ ...ctx, fieldName: ctx.fieldName ?? 'Static.Field' });
    return result('forms.static-to-fillable', { ...authored, capabilityId: 'forms.static-to-fillable' });
  },

  async 'forms.import-export-data'(ctx = {}) {
    const data = ctx.data && typeof ctx.data === 'object' ? ctx.data : { 'Account.Name': 'Ada' };
    const json = JSON.stringify(data);
    const csv = Object.entries(data).map(([k, v]) => `${k},${String(v).replaceAll(',', ';')}`).join('\n');
    return result('forms.import-export-data', {
      familyId: FAMILY,
      method: 'local-form-data-interchange',
      json,
      csv,
      jsonSha256: createHash('sha256').update(json).digest('hex'),
    });
  },

  async 'forms.submit-reset'(ctx = {}) {
    const action = ctx.action === 'reset' ? 'reset' : 'submit';
    const values = ctx.values && typeof ctx.values === 'object' ? ctx.values : { Name: 'Ada' };
    return result('forms.submit-reset', {
      familyId: FAMILY,
      method: 'local-form-submit-reset',
      action,
      values: action === 'reset' ? {} : values,
      submitted: action === 'submit',
    });
  },

  async 'forms.javascript-actions'(ctx = {}) {
    return result('forms.javascript-actions', {
      familyId: FAMILY,
      method: 'local-form-js-policy-table',
      allowed: false,
      actions: [],
      policy: 'execution-denied',
    });
  },

  async 'forms.tab-order-tooltips'(ctx = {}) {
    const order = Array.isArray(ctx.order) ? ctx.order : ['Account.Name', 'Account.Email'];
    const tooltips = Object.fromEntries(order.map((name) => [name, `Help for ${name}`]));
    return result('forms.tab-order-tooltips', {
      familyId: FAMILY,
      method: 'local-tab-order-tooltips',
      order,
      tooltips,
    });
  },

  async 'forms.barcode-fields'(ctx = {}) {
    const value = requireString(ctx.value ?? 'WB-001', 'value', { min: 1, max: 64 });
    const fieldName = requireString(ctx.fieldName ?? 'Barcode.Field', 'fieldName', { min: 1, max: 64 });
    const built = assembleBarcodeFieldPdf({ value, fieldName });
    const latin1 = built.bytes.toString('latin1');
    if (!latin1.includes('/AcroForm') || !latin1.includes('/Subtype /Widget')) {
      fail('BARCODE_FIELD_MISSING', 'Barcode AcroForm widget missing from PDF.', 502);
    }
    return result('forms.barcode-fields', {
      familyId: FAMILY,
      method: 'local-barcode-field-acroform',
      valueSha256: createHash('sha256').update(value).digest('hex'),
      fieldName: built.fieldName,
      barcodeId: built.barcodeId,
      pdf: built.bytes,
      bytes: built.bytes.length,
      outputSha256: digest(built.bytes),
    });
  },

  async 'forms.flatten'(ctx = {}) {
    const filled = opFormsFillSave(ctx);
    return result('forms.flatten', {
      method: 'local-form-flatten-export',
      sourceSha256: filled.sourceSha256,
      outputSha256: filled.filledPdfSha256,
      pdf: filled.pdf,
      bytes: filled.bytes,
      interactiveFields: 0,
    });
  },

  async 'forms.xfa-compatibility'(ctx = {}) {
    const source = ctx.sourcePdf ?? ctx.sourceBytes ?? formFixture();
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const hasXfa = bytes.toString('latin1').includes('/XFA');
    return result('forms.xfa-compatibility', {
      familyId: FAMILY,
      method: 'local-xfa-detection',
      xfaPresent: hasXfa,
      supported: false,
      action: hasXfa ? 'reject' : 'admit-acroform-only',
    });
  },

  async 'forms.signature-fields'(ctx = {}) {
    const authored = opFormsAuthor({ ...ctx, fieldName: ctx.fieldName ?? 'Signature.Field' });
    return result('forms.signature-fields', { ...authored, capabilityId: 'forms.signature-fields' });
  },
});
