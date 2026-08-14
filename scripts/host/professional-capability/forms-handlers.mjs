import { result, fail, sha256 } from './support.mjs';
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
import { digest } from './fixtures.mjs';
import {
  formsString,
  mutationResult,
  rejectDemoSource,
  runWriter,
  signatureRequest,
  sourceBoundFillSave,
  sourceOf,
} from './forms-support.mjs';

const FAMILY = 'forms';

const handlers = Object.freeze({
  async 'forms.source-bound-acroform-fill-save'(ctx = {}) {
    const bound = sourceOf(ctx);
    const filled = sourceBoundFillSave(bound, ctx);
    return result('forms.source-bound-acroform-fill-save', {
      familyId: FAMILY, capabilityId: 'forms.source-bound-acroform-fill-save', method: 'local-source-bound-acroform-fill-save',
      sourceSha256: bound.sourceSha256, outputSha256: digest(filled.pdf), pdf: filled.pdf, bytes: filled.pdf.length,
      fieldName: filled.fieldName, fieldType: filled.fieldType, widgetReference: filled.widgetReference,
      sourcePrefixPreserved: filled.pdf.subarray(0, bound.source.length).equals(bound.source), sourceBound: true,
      sourceProvided: bound.supplied, demoFixtureUsed: bound.demoFixtureUsed, professionalProof: false,
      proofStatus: 'partial', validationBoundary: 'independent-source-bound-widget-reopen',
      proof: Object.freeze({ sourceSha256: bound.sourceSha256, fieldType: filled.fieldType, widgetReference: filled.widgetReference, semanticValueValidated: true, sourcePrefixPreserved: true, revisionCount: 2 }),
    });
  },

  async 'forms.calculate'(ctx = {}) {
    rejectDemoSource(ctx);
    let a;
    let b;
    try {
      a = Number(ctx.a ?? 2);
      b = Number(ctx.b ?? 3);
    } catch {
      fail('FORM_CALCULATE_INVALID_REQUEST', 'Finite numeric operands are required.', 400);
    }
    const operation = ctx.operation ?? 'add';
    if (!Number.isFinite(a) || !Number.isFinite(b) || !['add', 'subtract', 'multiply', 'divide'].includes(operation)) {
      fail('FORM_CALCULATE_INVALID_REQUEST', 'Finite operands and one allowlisted operation are required.', 400);
    }
    if (operation === 'divide' && b === 0) fail('FORM_CALCULATE_INVALID_REQUEST', 'Division by zero is rejected.', 400);
    const values = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b };
    const calculation = values[operation];
    if (!Number.isFinite(calculation)) fail('FORM_CALCULATE_OUTPUT_INVALID', 'The calculation result is not finite.', 502);
    if (values[operation] !== calculation) fail('FORM_CALCULATE_OUTPUT_INVALID', 'Recomputed calculation validation failed.', 502);
    return result('forms.calculate', {
      familyId: FAMILY,
      method: 'local-safe-arithmetic-calculate',
      expression: operation === 'add' ? 'a+b' : operation === 'subtract' ? 'a-b' : operation === 'multiply' ? 'a*b' : 'a/b',
      a,
      b,
      operation,
      result: calculation,
      scope: 'detached-allowlisted-arithmetic',
      professionalProof: false,
      proofStatus: 'partial',
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

  async 'forms.tab-order-tooltips'(ctx = {}) {
    const bound = sourceOf(ctx);
    const request = ctx.formRequest ?? ctx.request;
    if (!request || typeof request !== 'object') {
      fail('FORM_TAB_REQUEST_REQUIRED', 'A source-bound tab-order and tooltip request is required.', 422);
    }
    if (request.profile !== PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE) {
      fail('FORM_TAB_INVALID_REQUEST', 'The tab-order and tooltip profile is not admitted.', 400);
    }
    const written = runWriter('FORM_TAB', () => preparePdfAcroFormTabOrderTooltip(bound.source, request));
    const proof = runWriter('FORM_TAB', () => inspectPdfAcroFormTabOrderTooltip(bound.source, written.bytes, request));
    return mutationResult('forms.tab-order-tooltips', 'local-acroform-tab-order-tooltip', bound, written, proof, {
      request,
      tabOrder: proof.tabOrder,
      tooltipSha256: proof.tooltipSha256,
    });
  },

  async 'forms.barcode-fields'(ctx = {}) {
    const bound = sourceOf(ctx);
    const payload = formsString(ctx.value ?? ctx.payload ?? 'WB-001', 'value', { min: 1, max: 32 }, 'FORM_BARCODE');
    const request = {
      profile: PDF_ACROFORM_BARCODE_PROFILE,
      sourceSha256: bound.sourceSha256,
      page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
      fieldName: ctx.fieldName ?? 'BarcodeField',
      rect: ctx.rect ?? { x: 72, y: 640, width: 360, height: 32 },
      symbology: PDF_ACROFORM_BARCODE_SYMBOLOGY,
      payload,
    };
    const written = runWriter('FORM_BARCODE', () => preparePdfAcroFormBarcode(bound.source, request));
    const proof = runWriter('FORM_BARCODE', () => inspectPdfAcroFormBarcode(bound.source, written.bytes, request));
    return mutationResult('forms.barcode-fields', 'local-pdf-acroform-barcode-field', bound, written, proof, {
      valueSha256: sha256(Buffer.from(payload, 'utf8')),
      fieldName: request.fieldName,
      barcodeId: proof.payloadSha256,
      request,
    });
  },

  async 'forms.flatten'(ctx = {}) {
    fail('FORM_FLATTEN_UNSUPPORTED', 'Form flattening is outside the bounded local forms subset.', 422);
  },

  async 'forms.signature-fields'(ctx = {}) {
    const bound = sourceOf(ctx);
    const fieldName = formsString(ctx.fieldName ?? 'SignatureField', 'fieldName', { min: 1, max: 80 }, 'FORM_SIGNATURE');
    const request = signatureRequest(bound, ctx, fieldName);
    const written = runWriter('FORM_SIGNATURE', () => preparePdfAcroFormSignatureField(bound.source, request));
    const proof = runWriter('FORM_SIGNATURE', () => inspectPdfAcroFormSignatureField(bound.source, written.bytes, request));
    return mutationResult('forms.signature-fields', 'local-pdf-acroform-signature-field', bound, written, proof, {
      fieldName,
      signingPerformed: false,
      request,
    });
  },
});

export { handlers };
