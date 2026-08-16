import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAcroFormValues } from '../scripts/host/pdf-acroform-validation-core.mjs';

test('AcroForm validation admits bounded regex compatibility cases without the backtracking engine', () => {
  const valid = validateAcroFormValues(
    { ssn: '123-45-6789' }, { ssn: { pattern: '^\\d{3}-\\d{2}-\\d{4}$' } }, { allowPattern: true },
  );
  assert.deepEqual(valid, []);
  const invalid = validateAcroFormValues(
    { ssn: 'bad' }, { ssn: { pattern: '^\\d{3}-\\d{2}-\\d{4}$' } }, { allowPattern: true },
  );
  assert.deepEqual(invalid, [{ field: 'ssn', code: 'PATTERN' }]);
  assert.deepEqual(validateAcroFormValues(
    { optional: 'anything' }, { optional: { pattern: '' } }, { allowPattern: true },
  ), []);
});

test('AcroForm validation rejects nested quantifiers and handles long non-matches predictably', () => {
  assert.throws(() => validateAcroFormValues(
    { value: 'a'.repeat(10_000) + '!' }, { value: { pattern: '(a+)+$' } }, { allowPattern: true },
  ), { code: 'INVALID_PDF_ACROFORM_VALIDATION' });
  const started = Date.now();
  const result = validateAcroFormValues(
    { value: 'a'.repeat(10_000) + '!' }, { value: { pattern: 'a+a+a+a+a+a+a+$' } }, { allowPattern: true },
  );
  assert.deepEqual(result, [{ field: 'value', code: 'PATTERN' }]);
  assert.ok(Date.now() - started < 1_000, 'bounded NFA evaluation should not backtrack exponentially');
});
