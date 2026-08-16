import {
  FIELD_TYPES, MAX_PAGE, MAX_RECORDS, MAX_RECT, MAX_TEXT, SAFE_REGEX,
  fail, id, integer, rect, string,
} from './review-forms-validation.mjs';
import { compileBoundedRegex } from '../bounded-regex.mjs';

function calculation(expression) {
  const text = string(expression, 'calculation', { required: true, max: 512 });
  if (!/^(sum|average|min|max|product)\([A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\)$/.test(text)) {
    fail('INVALID_CALCULATION', 'Calculations are limited to named aggregate expressions.');
  }
  return text;
}

function field(workspace, input) {
  const type = string(input?.type, 'field type', { required: true, max: 32 });
  if (!FIELD_TYPES.has(type)) fail('INVALID_FIELD_TYPE', 'Unsupported field type.');
  const options = input.options == null ? [] : input.options;
  if (!Array.isArray(options) || options.length > 100) fail('INVALID_OPTIONS', 'options must be a bounded array.');
  const normalizedOptions = options.map((value) => string(value, 'option', { required: true, max: 256 }));
  if (new Set(normalizedOptions).size !== normalizedOptions.length) fail('INVALID_OPTIONS', 'options must be unique.');
  if (['radio', 'select'].includes(type) && !normalizedOptions.length) fail('INVALID_OPTIONS', 'This field type requires options.');
  const validation = input.validation ?? {};
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) fail('INVALID_VALIDATION', 'validation must be an object.');
  if (validation.pattern !== undefined && typeof validation.pattern !== 'string') fail('UNSAFE_PATTERN', 'Only bounded simple validation patterns are supported.');
  if (validation.pattern) {
    try {
      if (!SAFE_REGEX.test(validation.pattern)) throw new TypeError('restricted syntax');
      compileBoundedRegex(validation.pattern, { maximum: 120 });
    } catch { fail('UNSAFE_PATTERN', 'Only bounded simple validation patterns are supported.'); }
  }
  if (validation.min !== undefined) integer(validation.min, 'minimum', -MAX_RECT, MAX_RECT);
  if (validation.max !== undefined) integer(validation.max, 'maximum', -MAX_RECT, MAX_RECT);
  if (validation.min !== undefined && validation.max !== undefined && validation.min > validation.max) {
    fail('INVALID_VALIDATION', 'minimum must not exceed maximum.');
  }
  return {
    id: input?.id == null ? workspace.newId('field') : id(input.id, 'field id'),
    name: string(input?.name, 'field name', { required: true, max: 128 }), type,
    page: integer(input?.page, 'page', 1, MAX_PAGE), rectangle: rect(input?.rectangle),
    tabOrder: integer(input?.tabOrder ?? 0, 'tabOrder', 0, MAX_RECORDS),
    tooltip: string(input?.tooltip ?? '', 'tooltip', { max: 500 }), required: Boolean(input?.required),
    defaultValue: input?.defaultValue ?? '', options: normalizedOptions,
    validation: { pattern: validation.pattern ?? '', min: validation.min, max: validation.max },
    calculation: !input?.calculation ? '' : calculation(input.calculation),
  };
}

function normalizeValue(record, value) {
  if (record.type === 'checkbox') {
    if (typeof value !== 'boolean') fail('INVALID_VALUE', 'checkbox values must be boolean.');
    return value;
  }
  if (record.type === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_VALUE', 'number values must be finite.');
    return value;
  }
  const normalized = string(value, 'field value', { max: MAX_TEXT });
  if ((record.type === 'radio' || record.type === 'select') && !record.options.includes(normalized)) {
    fail('INVALID_VALUE', 'Field value must be one of the defined options.');
  }
  return normalized;
}

function calculate(workspace, snapshot) {
  const values = new Map(snapshot.namespaces.formValues.map((value) => [value.id, value]));
  const calculatedFields = snapshot.namespaces.formFields.filter((record) => record.calculation);
  for (const record of calculatedFields) {
    const [, operation, names] = record.calculation.match(/^(sum|average|min|max|product)\((.+)\)$/) || [];
    const numbers = names.split(',').map((name) => {
      const sourceField = snapshot.namespaces.formFields.find((candidate) => candidate.name === name);
      return Number(values.get(sourceField?.id)?.value);
    });
    if (!numbers.length || numbers.some((number) => !Number.isFinite(number))) continue;
    let value;
    if (operation === 'sum') value = numbers.reduce((left, right) => left + right, 0);
    else if (operation === 'product') value = numbers.reduce((left, right) => left * right, 1);
    else if (operation === 'average') value = numbers.reduce((left, right) => left + right, 0) / numbers.length;
    else if (operation === 'min') value = Math.min(...numbers);
    else value = Math.max(...numbers);
    const calculated = { id: record.id, value, updatedAt: workspace.now() };
    const index = snapshot.namespaces.formValues.findIndex((candidate) => candidate.id === record.id);
    if (index < 0) snapshot.namespaces.formValues.push(calculated);
    else snapshot.namespaces.formValues[index] = calculated;
    values.set(record.id, calculated);
  }
}

function validate(snapshot) {
  const values = new Map(snapshot.namespaces.formValues.map((value) => [value.id, value.value]));
  return snapshot.namespaces.formFields.flatMap((record) => {
    const value = values.get(record.id);
    const errors = [];
    if (record.required && (value === '' || value === undefined || value === false)) errors.push('required');
    if (value !== '' && value !== undefined && record.validation.pattern && !compileBoundedRegex(record.validation.pattern, { maximum: 120 }).test(String(value))) errors.push('pattern');
    if (record.type === 'number' && Number.isFinite(value)) {
      if (record.validation.min !== undefined && value < record.validation.min) errors.push('min');
      if (record.validation.max !== undefined && value > record.validation.max) errors.push('max');
    }
    return errors.map((code) => ({ fieldId: record.id, code }));
  });
}

export function createFormEngine(workspace) {
  return {
    field: (input) => field(workspace, input),
    normalizeValue,
    calculate: (snapshot) => calculate(workspace, snapshot),
    validate,
  };
}
